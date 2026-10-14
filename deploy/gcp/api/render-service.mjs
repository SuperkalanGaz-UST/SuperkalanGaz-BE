#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const quote = JSON.stringify;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before rendering the Cloud Run service`);
  return value;
}

function resourceName(name, value) {
  if (!/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(`${name} must be a lowercase GCP resource name`);
  }
  return value;
}

function projectId(value) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)) {
    throw new Error('GCP_PROJECT_ID must be a valid project ID');
  }
  return value;
}

function origin(name, value, protocols) {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) throw new Error();
    return url;
  } catch {
    // Never echo a malformed URL: it might contain pasted credentials.
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment`);
  }
}

export function runtimeConfig(env) {
  const project = projectId(required(env, 'GCP_PROJECT_ID'));
  const repository = env.GCP_ARTIFACT_REPOSITORY?.trim() || 'superkalan-crm';
  resourceName('GCP_ARTIFACT_REPOSITORY', repository);
  const network = resourceName('GCP_VPC_NETWORK', required(env, 'GCP_VPC_NETWORK'));
  const subnet = resourceName('GCP_VPC_SUBNET', required(env, 'GCP_VPC_SUBNET'));
  const serviceAccount = required(env, 'GCP_RUNTIME_SERVICE_ACCOUNT');
  const emailSuffix = `@${project}.iam.gserviceaccount.com`;
  if (!serviceAccount.endsWith(emailSuffix) ||
      !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(serviceAccount.slice(0, -emailSuffix.length))) {
    throw new Error('GCP_RUNTIME_SERVICE_ACCOUNT must be a service-account email in GCP_PROJECT_ID');
  }

  function image(name) {
    const value = required(env, name);
    const prefix = `asia-southeast1-docker.pkg.dev/${project}/${repository}/`;
    if (!value.startsWith(prefix) ||
        !/^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(value.slice(prefix.length))) {
      throw new Error(`${name} must be a digest-pinned image in the selected Singapore project/repository`);
    }
    return value;
  }

  const secretRefs = [];
  function secret(nameVar, versionVar, optional = false) {
    const present = Boolean(env[nameVar]?.trim() || env[versionVar]?.trim());
    if (optional && !present) return null;
    const name = required(env, nameVar);
    const version = required(env, versionVar);
    if (!/^[A-Za-z0-9_-]{1,255}$/.test(name)) {
      throw new Error(`${nameVar} must be a Secret Manager secret ID`);
    }
    if (!/^[1-9]\d*$/.test(version)) {
      throw new Error(`${versionVar} must be a positive numeric Secret Manager version`);
    }
    if (secretRefs.some((ref) => ref.name === name)) {
      throw new Error('Each runtime secret must have a distinct Secret Manager secret ID');
    }
    const ref = { name, version };
    secretRefs.push(ref);
    return ref;
  }

  const database = secret('DATABASE_SECRET_NAME', 'DATABASE_SECRET_VERSION');
  const supabaseKey = secret('SUPABASE_SECRET_KEY_SECRET_NAME', 'SUPABASE_SECRET_KEY_SECRET_VERSION');
  const databaseCa = secret('SUPABASE_DB_CA_SECRET_NAME', 'SUPABASE_DB_CA_SECRET_VERSION');
  const jwt = secret('SUPABASE_JWT_SECRET_SECRET_NAME', 'SUPABASE_JWT_SECRET_SECRET_VERSION', true);
  const supabaseUrl = origin('SUPABASE_URL', required(env, 'SUPABASE_URL'), ['https:']).origin;
  const publishableKey = required(env, 'SUPABASE_PUBLISHABLE_KEY');
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey)) {
    throw new Error('SUPABASE_PUBLISHABLE_KEY must use the current sb_publishable_ format');
  }

  const webOrigins = (env.API_WEB_ORIGIN ?? 'http://localhost:3000').split(',').map((value) => value.trim());
  for (const value of webOrigins) {
    if (origin('API_WEB_ORIGIN', value, ['http:', 'https:']).origin !== value) {
      throw new Error('API_WEB_ORIGIN entries must be exact origins without a trailing slash');
    }
  }

  const traccarToken = secret('TRACCAR_TOKEN_SECRET_NAME', 'TRACCAR_TOKEN_SECRET_VERSION', true);
  const traccarCa = secret('TRACCAR_CA_SECRET_NAME', 'TRACCAR_CA_SECRET_VERSION', true);
  let traccar = null;
  if (env.TRACCAR_BASE_URL?.trim()) {
    for (const name of ['TRACCAR_TOKEN_SECRET_NAME', 'TRACCAR_TOKEN_SECRET_VERSION',
      'TRACCAR_CA_SECRET_NAME', 'TRACCAR_CA_SECRET_VERSION']) required(env, name);
    const url = origin('TRACCAR_BASE_URL', required(env, 'TRACCAR_BASE_URL'), ['https:']);
    // Only the approved VM private endpoint is in scope for this deployment.
    if (url.hostname !== '10.60.0.10' || url.port) {
      throw new Error('TRACCAR_BASE_URL must be https://10.60.0.10 on private HTTPS port 443');
    }
    traccar = { url: url.origin };
  }

  return { project, repository, network, subnet, serviceAccount, database, supabaseKey,
    databaseCa, jwt, supabaseUrl, publishableKey, webOrigins, traccar, traccarToken, traccarCa, secretRefs,
    apiImage: image('API_IMAGE'), nginxImage: image('NGINX_IMAGE') };
}

function secretEnv(name, ref) {
  return `            - name: ${name}
              valueFrom:
                secretKeyRef:
                  name: ${quote(ref.name)}
                  key: ${quote(ref.version)}`;
}

export function renderService(template, env) {
  const config = runtimeConfig(env);
  const optionalEnv = [];
  if (config.jwt) optionalEnv.push(secretEnv('SUPABASE_JWT_SECRET', config.jwt));
  if (config.traccar) {
    optionalEnv.push(`            - name: TRACCAR_BASE_URL
              value: ${quote(config.traccar.url)}`);
  }
  if (config.traccarToken) optionalEnv.push(secretEnv('TRACCAR_TOKEN', config.traccarToken));
  if (config.traccarCa) {
    optionalEnv.push(`            - name: NODE_EXTRA_CA_CERTS
              value: /var/run/secrets/traccar/root.crt`);
  }
  const values = {
    __VPC_NETWORKS_JSON__: quote([{ network: config.network, subnetwork: config.subnet, tags: ['superkalan-api'] }]),
    __RUNTIME_SERVICE_ACCOUNT__: quote(config.serviceAccount),
    __NGINX_IMAGE__: quote(config.nginxImage),
    __API_IMAGE__: quote(config.apiImage),
    __WEB_ORIGIN__: quote(config.webOrigins.join(',')),
    __SUPABASE_URL__: quote(config.supabaseUrl),
    __SUPABASE_PUBLISHABLE_KEY__: quote(config.publishableKey),
    __DATABASE_SECRET__: quote(config.database.name),
    __DATABASE_SECRET_VERSION__: quote(config.database.version),
    __SUPABASE_SECRET_KEY_SECRET__: quote(config.supabaseKey.name),
    __SUPABASE_SECRET_KEY_SECRET_VERSION__: quote(config.supabaseKey.version),
    __SUPABASE_DB_CA_SECRET__: quote(config.databaseCa.name),
    __SUPABASE_DB_CA_SECRET_VERSION__: quote(config.databaseCa.version),
    __OPTIONAL_SECRET_ENV__: optionalEnv.join('\n'),
    __OPTIONAL_CA_MOUNT__: config.traccarCa ? `            - name: traccar-ca
              mountPath: /var/run/secrets/traccar
              readOnly: true` : '',
    __OPTIONAL_CA_VOLUME__: config.traccarCa ? `        - name: traccar-ca
          secret:
            secretName: ${quote(config.traccarCa.name)}
            items:
              - key: ${quote(config.traccarCa.version)}
                path: root.crt
                mode: 292` : '',
  };
  let output = template;
  for (const [placeholder, value] of Object.entries(values)) {
    // A callback prevents replacement-string sequences in input from altering YAML.
    output = output.replaceAll(placeholder, () => value);
  }
  if (/__[A-Z0-9_]+__/.test(output)) throw new Error('The service template contains unresolved placeholders');
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === '--secret-refs') {
      for (const ref of runtimeConfig(process.env).secretRefs) {
        process.stdout.write(`${ref.name}\t${ref.version}\n`);
      }
    } else {
      if (!process.argv[2] || process.argv.length !== 3) {
        throw new Error('Usage: render-service.mjs <service.yaml.tmpl> | --secret-refs');
      }
      process.stdout.write(renderService(await readFile(process.argv[2], 'utf8'), process.env));
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
