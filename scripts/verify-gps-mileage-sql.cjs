const assert = require('node:assert/strict');
const fs = require('node:fs');
// Optional test-only dependency; never connects to the configured CRM database.
const { PGlite } = require(process.env.GPS_TEST_PGLITE_MODULE || '@electric-sql/pglite');
const root = require('node:path').resolve(__dirname, '..');
const { GpsMileageService } = require(root + '/dist/fleet/traccar/gps-mileage.service');
const { Vehicle } = require(root + '/dist/fleet/vehicle.entity');
const { Branch } = require(root + '/dist/branches/branch.entity');
const { Rider } = require(root + '/dist/fleet/rider.entity');

(async () => {
  const db = new PGlite({parsers: {20: value => value}});
  let calls = 0;
  let reading = { deviceId: '41', totalDistanceM: 10000, positionAt: new Date(Date.now() - 60000) };
  const a = '00000000-0000-4000-8000-000000000001';
  const b = '00000000-0000-4000-8000-000000000002';
  const v = '00000000-0000-4000-8000-000000000003';
  const other = '00000000-0000-4000-8000-000000000004';
  const rider = '00000000-0000-4000-8000-000000000005';
  let failRider = false;
  const columns = {
    id: 'id', branchId: 'branch_id', status: 'status', currentOdometerKm: 'current_odometer_km', updatedAt: 'updated_at',
    operationalLatitude: 'operational_latitude', operationalLongitude: 'operational_longitude', operationalAccuracyM: 'operational_accuracy_m',
    operationalLocationCapturedAt: 'operational_location_captured_at', operationalLocationReceivedAt: 'operational_location_received_at',
  };
  const vehicleRow = row => row && ({
    id: row.id, branchId: row.branch_id, traccarDeviceId: String(row.traccar_device_id),
    hardwareUniqueId: row.hardware_unique_id, status: row.status, traccarProvisioningStatus: row.traccar_provisioning_status,
    currentOdometerKm: row.current_odometer_km, lastPmsOdometerKm: row.last_pms_odometer_km, assignedRiderId: row.assigned_rider_id,
  });
  const managerFor = connection => ({
    query: async (sql, values) => (await connection.query(sql, values)).rows,
    findOne: async (entity, { where }) => {
      if (entity === Vehicle) return vehicleRow((await connection.query(
        'SELECT * FROM fleet.vehicles WHERE id=$1 AND branch_id=$2 AND traccar_device_id=$3 FOR UPDATE',
        [where.id, where.branchId, where.traccarDeviceId],
      )).rows[0]);
      if (entity === Branch) {
        const row = (await connection.query('SELECT * FROM core.branches WHERE id=$1', [where.id])).rows[0];
        return row && { maintenanceThresholdKm: row.maintenance_threshold_km };
      }
      throw new Error('Unknown entity');
    },
    update: async (entity, where, patch) => {
      if (entity === Rider && failRider) throw new Error('simulated rider write failure');
      const keys = Object.keys(patch), filters = Object.keys(where);
      const set = keys.map((key, i) => `${columns[key]}=$${i + 1}`).join(', ');
      const condition = filters.map((key, i) => `${columns[key]}=$${keys.length + i + 1}`).join(' AND ');
      await connection.query(`UPDATE fleet.${entity === Vehicle ? 'vehicles' : 'riders'} SET ${set} WHERE ${condition}`,
        [...keys.map(key => patch[key]), ...filters.map(key => where[key])]);
    },
  });
  try {
    await db.exec(`CREATE SCHEMA fleet; CREATE SCHEMA core;
      CREATE TABLE core.branches(id uuid PRIMARY KEY, maintenance_threshold_km int);
      CREATE TABLE fleet.vehicles(id uuid PRIMARY KEY, branch_id uuid, traccar_device_id bigint,
        hardware_unique_id text, traccar_provisioning_status text, traccar_provisioned_at timestamptz,
        status text, current_odometer_km int, last_pms_odometer_km int, assigned_rider_id uuid, updated_at timestamptz);
      CREATE TABLE fleet.riders(id uuid PRIMARY KEY, branch_id uuid, status text, updated_at timestamptz,
        operational_latitude float8, operational_longitude float8, operational_accuracy_m float8,
        operational_location_captured_at timestamptz, operational_location_received_at timestamptz);`);
    const migration = fs.readFileSync(root + '/migrations/0040_create_vehicle_gps_mileage.sql', 'utf8');
    await db.exec(migration);
    await db.exec(migration); // Repeatability.
    await db.query('INSERT INTO core.branches VALUES($1,3000),($2,3000)', [a,b]);
    await db.query(`INSERT INTO fleet.vehicles VALUES
      ($1,$2,41,'hardware-41','provisioned',now()-interval '1 day','active',2999,0,$3,now()),
      ($4,$5,42,'hardware-42','provisioned',now()-interval '1 day','active',500,0,NULL,now())`, [v,a,rider,other,b]);
    await db.query("INSERT INTO fleet.riders(id,branch_id,status) VALUES($1,$2,'Available')", [rider,a]);
    const source = {
      query: async (sql, args) => (await db.query(sql,args)).rows,
      getRepository: () => ({ find: async ({where}) => (await db.query('SELECT * FROM fleet.vehicles WHERE branch_id=$1',[where.branchId])).rows.map(vehicleRow) }),
      transaction: work => db.transaction(tx => work(managerFor(tx))),
    };
    const traccar = { latestDistances: async devices => {
      calls++;
      assert.deepEqual(devices, [{id:'41',uniqueId:'hardware-41'}]);
      return [reading];
    }};
    const service = new GpsMileageService(source, traccar, { get: () => undefined });
    const principal = {role:'branch-manager', userId:rider, branchIds:[a], branches:['A']};
    const current = async () => (await db.query('SELECT * FROM fleet.vehicles WHERE id=$1',[v])).rows[0];
    const due = async () => db.query("UPDATE fleet.vehicle_gps_mileage SET next_poll_at=now()-interval '1 second' WHERE branch_id=$1",[a]);
    await service.refresh(principal);
    assert.equal((await current()).current_odometer_km, 2999, 'first snapshot anchors, adds no history');
    await service.refresh(principal);
    assert.equal(calls,1,'database cooldown avoids extra upstream requests');
    assert.equal((await db.query('SELECT count(*)::int n FROM fleet.vehicle_gps_mileage WHERE branch_id=$1',[b])).rows[0].n,0,'other branch never claimed');
    await due();
    reading = {...reading,totalDistanceM:11500,positionAt:new Date(reading.positionAt.getTime()+30000)};
    await service.refresh(principal);
    assert.equal((await current()).current_odometer_km,3000);
    assert.equal((await current()).status,'maintenance');
    assert.equal((await db.query('SELECT status FROM fleet.riders WHERE id=$1',[rider])).rows[0].status,'Maintenance Due');
    assert.equal((await db.query('SELECT remainder_m FROM fleet.vehicle_gps_mileage WHERE vehicle_id=$1',[v])).rows[0].remainder_m,500);
    await due(); await service.refresh(principal);
    assert.equal((await current()).current_odometer_km,3000,'duplicate position does not add mileage');
    await due(); reading={...reading,totalDistanceM:200,positionAt:new Date(reading.positionAt.getTime()+1000)};
    await service.refresh(principal);
    assert.equal((await current()).current_odometer_km,3000,'counter reset preserves CRM odometer');
    await due(); reading={...reading,totalDistanceM:2200,positionAt:new Date(reading.positionAt.getTime()+1000)};
    failRider=true;
    await service.refresh(principal);
    assert.equal((await current()).current_odometer_km,3000,'rider failure rolls back vehicle and cursor');
    const unavailable=(await db.query('SELECT * FROM fleet.vehicle_gps_mileage WHERE vehicle_id=$1',[v])).rows[0];
    assert.equal(unavailable.total_distance_m,200);
    assert.equal(unavailable.status,'unavailable');
    assert.equal((await db.query('SELECT current_odometer_km FROM fleet.vehicles WHERE id=$1',[other])).rows[0].current_odometer_km,500);
    // Execute the actual manual-recalibration SQL against both a missing cursor
    // and an existing one. A first manual reading must anchor even before GPS
    // polling has ever created a cursor for that vehicle.
    const fleetSource = fs.readFileSync(root + '/src/fleet/fleet.service.ts', 'utf8');
    const manualSql = fleetSource.match(/INSERT INTO fleet\.vehicle_gps_mileage AS cache[\s\S]*?WHERE cache\.branch_id = \$2/)[0];
    await db.query(manualSql, [other,b]);
    const firstManual = (await db.query('SELECT * FROM fleet.vehicle_gps_mileage WHERE vehicle_id=$1 AND branch_id=$2',[other,b])).rows[0];
    assert.equal(firstManual.total_distance_m,null);
    assert.ok(firstManual.baseline_after.getTime() > reading.positionAt.getTime());
    await db.query(manualSql, [v,a]);
    const recalibrated = (await db.query('SELECT * FROM fleet.vehicle_gps_mileage WHERE vehicle_id=$1 AND branch_id=$2',[v,a])).rows[0];
    assert.equal(recalibrated.total_distance_m,null);
    assert.equal(recalibrated.remainder_m,0);
    assert.equal(recalibrated.status,'waiting');
    console.log('PASS: PostgreSQL migration repeatability, real cooldown SQL, branch isolation, baseline, delta, PMS, duplicates, reset, rollback and manual recalibration.');
  } finally { await db.close(); }
})().catch(error => { console.error(error); process.exitCode=1; });
