import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { GoTrueAdminService } from '../users/gotrue-admin.service';

/**
 * One-time bootstrap for the first Super Administrator. Later Franchise
 * Administrator accounts must use the authenticated Super Administrator
 * invitation path; this script never provisions Franchise Administrators.
 * Credentials come exclusively from uncommitted environment variables.
 */
async function run(): Promise<void> {
  const email = process.env.SUPER_ADMIN_EMAIL?.trim();
  const password = process.env.SUPER_ADMIN_PASSWORD;
  const displayName = process.env.SUPER_ADMIN_NAME?.trim();
  const phone = process.env.SUPER_ADMIN_PHONE?.trim() || null;

  if (!email || !password || !displayName) {
    throw new Error(
      'SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD, and SUPER_ADMIN_NAME are required',
    );
  }
  if (password.length < 12) {
    throw new Error('SUPER_ADMIN_PASSWORD must contain at least 12 characters');
  }
  if (phone && !/^\+639\d{9}$/.test(phone)) {
    throw new Error('SUPER_ADMIN_PHONE must use canonical PH E.164 format');
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });
  try {
    const goTrue = app.get(GoTrueAdminService);
    const existing = await goTrue.findByEmail(email);
    if (existing) {
      if (existing.app_metadata?.role !== 'super-admin') {
        throw new Error('The configured email already belongs to a different CRM role');
      }
      console.log(`[seed] super-admin — already provisioned: ${email}`);
      return;
    }

    const created = await goTrue.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: {
        username: email.split('@')[0],
        display_name: displayName,
        role: 'super-admin',
        branches: [],
        phone,
        status: 'Active',
      },
    });
    console.log(`[seed] super-admin — provisioned ${email} (${created.id})`);
  } finally {
    await app.close();
  }
}

run().catch((error: unknown) => {
  console.error('[seed] super-admin failed:', error);
  process.exit(1);
});
