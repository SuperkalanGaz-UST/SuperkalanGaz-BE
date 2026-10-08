# GCP Traccar VM files

This Compose stack is a starting deployment configuration, not a deployed service.
It runs Traccar and MySQL with persistent named volumes. It publishes only the
configured TCP device listener; Traccar's raw web/API port 8082 and MySQL 3306
are not published on the VM host.

## Before starting containers

1. Confirm the exact ST-901 variant and transport with the device supplier. The
   standard ST-901 uses H02/TCP 5013; ST-901 A+ uses JT808/TCP 5015. Set
   `TRACCAR_DEVICE_PORT` to the matching Traccar listener; do not open a public
   port until the actual unit is verified. The GCP firewall must allow only that
   one device listener, not a protocol range.
2. Complete the free-credit and full-runtime cost gate. The 24/7 VM, disk, static
   IP, image storage, logs, networking, and backups all count toward the credit cap.
3. Copy .env.example to .env, replace both database passwords with different
   generated secrets, and protect it with chmod 600. Never commit .env.
4. Validate the Compose model without printing interpolated secrets:

       docker compose --env-file .env config --quiet

5. Start only after the approved VM, firewall, disk, backup, and restore plan is in
   place:

       docker compose --env-file .env up -d --wait

The Traccar web/API endpoint is private to the Compose network by default. The
private-api profile adds NGINX on the VM's private IP at TCP 443; it requires
the TLS certificate and key under the ignored certs/ directory. The certificate
must match the address/name the Cloud Run API will call, and its issuing CA must
be trusted by that API container. The exact private TLS trust and VPC design is
still a deployment gate; do not enable this profile until that is proven and the
firewall allows 443 only from the approved Cloud Run path.

The sample memory limits are initial guardrails for a 2 GB-class VM, not evidence
that the workload fits. Check host and container memory while testing realistic
device traffic; adjust only with measured headroom. A named volume is persistence,
not a backup. The off-VM encrypted backup destination, retention, and restore
drill still need to be selected and tested before production use.

## Release notes

The example uses version tags for Traccar 6.16.0 and MySQL 8.4. Before first use,
verify compatibility, run the stack in a disposable environment, and record the
resolved image digests together with the release. Do not use floating latest
tags in a production release.
