import * as bcrypt from 'bcrypt';
import AppDataSource from './data-source';
import { User, UserRole } from '../users/user.entity';
import { Location } from '../locations/location.entity';
import { Asset, AssetAuditStatus, AssetConditionGrade, AssetStockStatus } from '../assets/asset.entity';
import { AssetHistory, AssetEventType } from '../assets/asset-history.entity';
import { AssetAudit, DataWipeStatus, FinalDisposition } from '../assets/asset-audit.entity';

const SEED_PASSWORD = 'password123';

async function seed() {
  await AppDataSource.initialize();

  const userRepo = AppDataSource.getRepository(User);
  const locationRepo = AppDataSource.getRepository(Location);
  const assetRepo = AppDataSource.getRepository(Asset);
  const historyRepo = AppDataSource.getRepository(AssetHistory);
  const auditRepo = AppDataSource.getRepository(AssetAudit);

  const existing = await userRepo.count();
  if (existing > 0) {
    console.log('Database already has users — skipping seed. Delete rows manually to re-seed.');
    await AppDataSource.destroy();
    return;
  }

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  const admin = await userRepo.save(
    userRepo.create({
      name: 'Ada Admin',
      email: 'admin@als.com',
      passwordHash,
      role: UserRole.ADMIN,
    }),
  );

  const manager = await userRepo.save(
    userRepo.create({
      name: 'Mona Manager',
      email: 'manager@als.com',
      passwordHash,
      role: UserRole.MANAGER,
    }),
  );

  const technician = await userRepo.save(
    userRepo.create({
      name: 'Tim Technician',
      email: 'tech@als.com',
      passwordHash,
      role: UserRole.TECHNICIAN,
    }),
  );

  const hq = await locationRepo.save(
    locationRepo.create({ name: 'HQ Office', address: '1 Corporate Way' }),
  );

  const warehouse = await locationRepo.save(
    locationRepo.create({
      name: 'Main Warehouse',
      address: '22 Industrial Park Rd',
      assignedUserId: technician.id,
    }),
  );

  const in20Days = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const lastMonth = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const assetSeeds = [
    {
      tag: 'AST-0001',
      name: 'Dell Latitude 5440',
      category: 'Laptop',
      location: warehouse,
      stockStatus: AssetStockStatus.IN_STOCK,
      conditionGrade: AssetConditionGrade.GRADE_A,
      auditStatus: AssetAuditStatus.READY_FOR_SALE,
      warrantyExpiresAt: in20Days,
    },
    {
      tag: 'AST-0002',
      name: 'Dell Latitude 5440',
      category: 'Laptop',
      location: warehouse,
      stockStatus: AssetStockStatus.AWAITING_AUDIT,
    },
    {
      tag: 'AST-0003',
      name: 'HP LaserJet Pro M404',
      category: 'Printer',
      location: hq,
      stockStatus: AssetStockStatus.ALLOCATED,
      owner: manager,
      warrantyExpiresAt: lastMonth,
    },
    {
      tag: 'AST-0004',
      name: 'Dell 27" Monitor',
      category: 'Monitor',
      location: warehouse,
      stockStatus: AssetStockStatus.IN_STOCK,
      conditionGrade: AssetConditionGrade.GRADE_B,
    },
    {
      tag: 'AST-0005',
      name: 'Cisco Catalyst 9200 Switch',
      category: 'Networking',
      location: hq,
      stockStatus: AssetStockStatus.QUARANTINED,
      auditStatus: AssetAuditStatus.REPAIR_REQUIRED,
    },
  ];

  const createdAssets: Record<string, Asset> = {};

  for (const s of assetSeeds) {
    const asset = await assetRepo.save(
      assetRepo.create({
        tag: s.tag,
        name: s.name,
        category: s.category,
        stockStatus: s.stockStatus,
        conditionGrade: s.conditionGrade ?? null,
        auditStatus: s.auditStatus ?? null,
        locationId: s.location.id,
        ownerId: s.owner?.id ?? null,
        warrantyExpiresAt: s.warrantyExpiresAt ?? null,
      }),
    );
    createdAssets[s.tag] = asset;
    await historyRepo.save(
      historyRepo.create({
        assetId: asset.id,
        eventType: AssetEventType.CREATED,
        userId: admin.id,
        notes: 'Seeded asset',
      }),
    );
  }

  // A full ITAD audit record on AST-0001, demonstrating the audit trail
  // (the asset's grade/audit status above reflect this audit's outcome).
  await auditRepo.save(
    auditRepo.create({
      assetId: createdAssets['AST-0001'].id,
      auditStatus: AssetAuditStatus.READY_FOR_SALE,
      manufacturer: 'Dell',
      model: 'Latitude 5440',
      serialNumber: 'DL5440-SN-0001',
      cpu: 'Intel Core i7-1355U',
      ramGb: 16,
      storageCapacity: '512GB SSD',
      screenSize: '14"',
      screenResolution: '1920x1080',
      batteryHealth: '92%',
      cosmeticGrade: AssetConditionGrade.GRADE_A,
      functionalTests: { keyboard: 'pass', ports: 'pass', webcam: 'pass', wifi: 'pass', speakers: 'pass' },
      biosLocked: false,
      chargerIncluded: true,
      dataWipeStatus: DataWipeStatus.WIPED,
      dataWipeMethod: 'NIST 800-88 Purge',
      finalDisposition: FinalDisposition.SELL,
      auditedById: technician.id,
    }),
  );
  await historyRepo.save(
    historyRepo.create({
      assetId: createdAssets['AST-0001'].id,
      eventType: AssetEventType.AUDITED,
      userId: technician.id,
      notes: 'Audit recorded — disposition: sell',
    }),
  );

  console.log('Seed complete:');
  console.log(`  admin@als.com / ${SEED_PASSWORD}`);
  console.log(`  manager@als.com / ${SEED_PASSWORD}`);
  console.log(`  tech@als.com / ${SEED_PASSWORD}`);
  console.log(`  ${assetSeeds.length} assets created at HQ Office / Main Warehouse (AST-0001 has a full ITAD audit record)`);

  await AppDataSource.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
