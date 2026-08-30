import {
  hasMetadataBranchIds,
  metadataBranchIds,
  metadataBranchNames,
  withBranchScope,
} from './branch-scope';

describe('branch scope claims', () => {
  const first = '11111111-1111-4111-8111-111111111111';
  const second = '22222222-2222-4222-8222-222222222222';

  it('accepts only unique UUIDs from the protected branch_ids claim', () => {
    expect(metadataBranchIds({ branch_ids: [first, 'not-a-uuid', first, second] })).toEqual([
      first,
      second,
    ]);
  });

  it('keeps branch names display-only and separate from authorization UUIDs', () => {
    expect(metadataBranchIds({ branches: ['Alfonso, Cavite'] })).toEqual([]);
    expect(hasMetadataBranchIds({ branches: ['Alfonso, Cavite'] })).toBe(false);
    expect(hasMetadataBranchIds({ branch_ids: [], branches: ['Alfonso, Cavite'] })).toBe(
      true,
    );
    expect(metadataBranchNames({ branches: ['Alfonso, Cavite'] })).toEqual([
      'Alfonso, Cavite',
    ]);
  });

  it('writes aligned UUID and display-name projections without dropping other claims', () => {
    expect(
      withBranchScope(
        { role: 'branch-owner', status: 'Active' },
        [
          { id: first, name: 'Alfonso, Cavite' },
          { id: second, name: 'Las Pinas 1' },
        ],
      ),
    ).toEqual({
      role: 'branch-owner',
      status: 'Active',
      branch_ids: [first, second],
      branches: ['Alfonso, Cavite', 'Las Pinas 1'],
    });
  });
});
