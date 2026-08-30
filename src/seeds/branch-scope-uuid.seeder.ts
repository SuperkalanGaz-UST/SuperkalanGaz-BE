import { NestFactory } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppModule } from '../app.module';
import {
  hasMetadataBranchIds,
  metadataBranchIds,
  metadataBranchNames,
  withBranchScope,
} from '../auth/branch-scope';
import { Branch } from '../branches/branch.entity';
import { GoTrueAdminService, GoTrueUser } from '../users/gotrue-admin.service';

interface PlannedUserUpdate {
  user: GoTrueUser;
  scope: Branch[];
}

/**
 * One-time, idempotent migration from editable branch-name claims to protected
 * UUID claims. It preflights every account before writing anything and refuses
 * ambiguous duplicate-name mappings rather than guessing a tenant boundary.
 *
 * Run after SQL migration 0029: npm run migrate:branch-scope-uuid
 */
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  try {
    const branches = app.get<Repository<Branch>>(getRepositoryToken(Branch));
    const goTrue = app.get(GoTrueAdminService);
    const branchRows = await branches.find();
    const byId = new Map(branchRows.map((branch) => [branch.id, branch]));
    const byName = new Map<string, Branch[]>();
    for (const branch of branchRows) {
      byName.set(branch.name, [...(byName.get(branch.name) ?? []), branch]);
    }

    const users = await goTrue.listUsers();
    const plan: PlannedUserUpdate[] = [];
    const ownerByBranch = new Map<string, string>();

    for (const user of users) {
      const claimedIds = metadataBranchIds(user.app_metadata);
      const legacyNames = metadataBranchNames(user.app_metadata);
      const scope = hasMetadataBranchIds(user.app_metadata)
        ? claimedIds.map((id) => {
            const branch = byId.get(id);
            if (!branch) throw new Error(`User ${user.id} references unknown branch UUID ${id}`);
            return branch;
          })
        : legacyNames.map((name) => {
            const matches = byName.get(name) ?? [];
            if (matches.length !== 1) {
              throw new Error(
                `User ${user.id} branch name "${name}" resolved to ${matches.length} rows`,
              );
            }
            return matches[0];
          });

      if (user.app_metadata?.role === 'branch-manager' && scope.length !== 1) {
        throw new Error(`Branch Manager ${user.id} must have exactly one assigned branch`);
      }
      if (user.app_metadata?.role === 'branch-owner') {
        for (const branch of scope) {
          const existingOwner = ownerByBranch.get(branch.id);
          if (existingOwner && existingOwner !== user.id) {
            throw new Error(`Branch ${branch.id} is assigned to multiple Branch Owners`);
          }
          ownerByBranch.set(branch.id, user.id);
        }
      }
      plan.push({ user, scope });
    }

    for (const { user, scope } of plan) {
      await goTrue.updateUser(user.id, {
        app_metadata: withBranchScope(user.app_metadata, scope),
      });
    }

    for (const branch of branchRows) {
      const ownerId = ownerByBranch.get(branch.id) ?? null;
      if (branch.ownerId === ownerId) continue;
      branch.ownerId = ownerId;
      branch.updatedAt = new Date();
      await branches.save(branch);
    }

    console.log(
      `[migration] UUID branch scope applied to ${plan.length} users and ${ownerByBranch.size} owned branches`,
    );
  } finally {
    await app.close();
  }
}

run().catch((error: unknown) => {
  console.error('[migration] UUID branch scope failed:', error);
  process.exit(1);
});
