import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Principal } from '../auth/principal';
import { FranchiseReportsQuery } from './franchise-reports.query';

type Row = Record<string, unknown>;
export interface Page { rows: Row[]; total: number; summary?: Row; }

const MONTH = "(date_trunc('month', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila')";

// Preaggregate each relation independently: joining raw orders and ratings would
// multiply counts. Every relationship includes branch_id, including loyalty.
const PROFILES = `WITH profiles AS (
  SELECT c.id, c.name, c.contact_number AS phone, c.delivery_address AS address,
    c.customer_code AS code, c.account_type AS "accountType", c.branch_id AS "branchId",
    b.name AS "primaryBranch", COALESCE(o.total, 0)::int AS "totalOrders",
    o.last_order AS "lastOrder", r.average::float AS "avgRating", COALESCE(r.count, 0)::int AS "ratingCount",
    CASE WHEN c.account_type = 'commercial' THEN COALESCE(l.current_cycle_count, 0)
      ELSE COALESCE(h.points_balance, 0) END::int AS "loyaltyPoints",
    CASE WHEN c.account_type = 'commercial' THEN COALESCE(l.completed_cycles, 0) > 0
      ELSE EXISTS (SELECT 1 FROM loyalty.catalog_items ci WHERE ci.branch_id = c.branch_id
        AND ci.is_active AND ci.stock_qty > 0 AND ci.points_cost <= COALESCE(h.points_balance, 0)) END AS "rewardEligible"
  FROM cim.customers c
  JOIN core.branches b ON b.id = c.branch_id
  LEFT JOIN (SELECT customer_id, branch_id, COUNT(*) AS total, MAX(requested_at) AS last_order
    FROM srd.service_requests WHERE deleted_at IS NULL GROUP BY customer_id, branch_id) o
    ON o.customer_id = c.id AND o.branch_id = c.branch_id
  LEFT JOIN (SELECT customer_id, branch_id, AVG(stars) AS average, COUNT(*) AS count
    FROM csat.ratings GROUP BY customer_id, branch_id) r ON r.customer_id = c.id AND r.branch_id = c.branch_id
  LEFT JOIN loyalty.household_loyalty_accounts h ON h.customer_id = c.id AND h.branch_id = c.branch_id
  LEFT JOIN loyalty.commercial_loyalty_accounts l ON l.customer_id = c.id AND l.branch_id = c.branch_id
  WHERE c.deleted_at IS NULL AND ($1::uuid IS NULL OR c.branch_id = $1)
    AND ($2::text IS NULL OR c.name ILIKE $2 OR c.contact_number ILIKE $2 OR b.name ILIKE $2)
    AND ($4::uuid IS NULL OR c.id = $4)
), filtered AS (SELECT *, CASE WHEN "rewardEligible" THEN 'Reward Eligible' ELSE 'Active' END AS status
  FROM profiles WHERE $3::text IS NULL OR $3 = 'all' OR $3 = 'Active' AND NOT "rewardEligible"
    OR $3 = 'Reward Eligible' AND "rewardEligible")`;

@Injectable()
export class FranchiseReportsService {
  constructor(private readonly db: DataSource) {}

  private authorize(p: Principal) {
    if (p.role !== 'franchise-admin') throw new ForbiddenException('Franchise Administrator access required');
  }

  private async page(sql: string, parameters: unknown[]): Promise<Page> {
    const [result] = await this.db.query<Page[]>(sql, parameters);
    return result;
  }

  async customers(p: Principal, q: FranchiseReportsQuery, id?: string): Promise<Page> {
    this.authorize(p);
    return this.page(`${PROFILES}
      SELECT (SELECT COUNT(*)::int FROM filtered) AS total,
      jsonb_build_object('customers', COUNT(*)::int, 'eligible', COUNT(*) FILTER (WHERE "rewardEligible")::int,
        'orders', COALESCE(SUM("totalOrders"), 0)::int,
        'averageRating', SUM("avgRating" * "ratingCount") / NULLIF(SUM("ratingCount"), 0)) AS summary,
      COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM filtered ORDER BY lower(name), id LIMIT $5 OFFSET $6) x), '[]') AS rows
      FROM filtered`, [q.branchId ?? null, q.search?.trim() ? `%${q.search.trim()}%` : null,
      q.status ?? null, id ?? null, q.limit, (q.page - 1) * q.limit]);
  }

  async customer(p: Principal, id: string) {
    this.authorize(p);
    const directory = await this.customers(p, new FranchiseReportsQuery(), id);
    const customer = directory.rows[0];
    if (!customer) throw new NotFoundException('Customer not found');
    // CIM profiles are branch-owned. Do not merge unrelated people by name/phone.
    const orders = await this.db.query<Row[]>(`SELECT s.id, s.sr_code AS "orderNo", b.name AS branch,
      s.requested_at AS date, s.status, r.stars AS rating FROM srd.service_requests s
      JOIN cim.customers c ON c.id = s.customer_id AND c.branch_id = s.branch_id AND c.deleted_at IS NULL
      JOIN core.branches b ON b.id = s.branch_id
      LEFT JOIN csat.ratings r ON r.service_request_id = s.id AND r.branch_id = s.branch_id
      WHERE s.deleted_at IS NULL AND c.id = $1 ORDER BY s.requested_at DESC, s.id DESC LIMIT 100`, [id]);
    return { customer, orders };
  }

  async orders(p: Principal, q: FranchiseReportsQuery) {
    this.authorize(p);
    const [summary] = await this.db.query<Row[]>(`WITH orders AS (
      SELECT s.*, b.name AS branch FROM srd.service_requests s JOIN core.branches b ON b.id = s.branch_id
      WHERE s.deleted_at IS NULL AND ($1::uuid IS NULL OR s.branch_id = $1)
        AND s.requested_at >= ${MONTH} AND s.requested_at < ${MONTH} + interval '1 month'
    ) SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'Delivered')::int AS delivered,
      COUNT(*) FILTER (WHERE status = 'Cancelled')::int AS cancelled,
      COALESCE((SELECT jsonb_agg(x ORDER BY x.day) FROM (SELECT to_char(requested_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM-DD') AS day,
        COUNT(*)::int AS orders FROM orders GROUP BY day) x), '[]') AS daily,
      COALESCE((SELECT jsonb_agg(x) FROM (SELECT status AS name, COUNT(*)::int AS count FROM orders GROUP BY status) x), '[]') AS statuses,
      COALESCE((SELECT jsonb_agg(x) FROM (SELECT o.customer_id AS id, c.name, o.branch,
        COUNT(*)::int AS "totalOrders" FROM orders o JOIN cim.customers c
          ON c.id = o.customer_id AND c.branch_id = o.branch_id AND c.deleted_at IS NULL
        GROUP BY o.customer_id, c.name, o.branch
        ORDER BY COUNT(*) DESC, o.customer_id LIMIT 5) x), '[]') AS "topCustomers" FROM orders`, [q.branchId ?? null]);
    const completion = await this.db.query<Row[]>(`SELECT s.branch_id AS "branchId", b.name AS branch,
      to_char(s.requested_at AT TIME ZONE 'Asia/Manila', 'YYYY-MM') AS month,
      COUNT(*)::int AS "totalOrders", COUNT(*) FILTER (WHERE s.status = 'Delivered')::int AS completed,
      COUNT(*) FILTER (WHERE s.sla_breached)::int AS "slaBreaches"
      FROM srd.service_requests s JOIN core.branches b ON b.id = s.branch_id WHERE s.deleted_at IS NULL
        AND ($1::uuid IS NULL OR s.branch_id = $1) AND s.requested_at >= ${MONTH} - interval '5 months'
        AND s.requested_at < ${MONTH} + interval '1 month'
      GROUP BY s.branch_id, b.name, month ORDER BY month DESC, b.name`, [q.branchId ?? null]);
    return { ...summary, completion };
  }

  async csat(p: Principal, q: FranchiseReportsQuery) {
    this.authorize(p);
    const [summary] = await this.db.query<Row[]>(`SELECT COUNT(*)::int AS total, AVG(stars)::float AS rating,
      (SELECT COUNT(*)::int FROM csat.incidents WHERE status IN ('open', 'in_progress')
        AND ($1::uuid IS NULL OR branch_id = $1)) AS complaints
      FROM csat.ratings WHERE $1::uuid IS NULL OR branch_id = $1`, [q.branchId ?? null]);
    return summary;
  }

  async ratings(p: Principal, q: FranchiseReportsQuery): Promise<Page> {
    this.authorize(p);
    return this.page(`WITH filtered AS (SELECT r.id, r.customer_id AS "customerId", r.branch_id AS "branchId", b.name AS branch,
      COALESCE(c.name, s.customer_name, 'Customer unavailable') AS customer, COALESCE(s.sr_code, r.service_request_id::text) AS "orderId",
      r.stars AS rating, COALESCE(r.comment, '') AS comment, r.submitted_at AS date, r.resolution_status AS resolution
      FROM csat.ratings r JOIN core.branches b ON b.id = r.branch_id
      LEFT JOIN cim.customers c ON c.id = r.customer_id AND c.branch_id = r.branch_id AND c.deleted_at IS NULL
      LEFT JOIN srd.service_requests s ON s.id = r.service_request_id AND s.branch_id = r.branch_id AND s.deleted_at IS NULL
      WHERE ($1::uuid IS NULL OR r.branch_id = $1) AND ($2::int IS NULL OR r.stars = $2)
        AND ($3::text IS NULL OR COALESCE(c.name, s.customer_name, '') ILIKE $3 OR r.comment ILIKE $3 OR s.sr_code ILIKE $3))
      SELECT (SELECT COUNT(*)::int FROM filtered) AS total,
        COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM filtered ORDER BY date DESC, id DESC LIMIT $4 OFFSET $5) x), '[]') AS rows`,
      [q.branchId ?? null, q.stars ?? null, q.search?.trim() ? `%${q.search.trim()}%` : null, q.limit, (q.page - 1) * q.limit]);
  }

  async incidents(p: Principal, q: FranchiseReportsQuery): Promise<Page> {
    this.authorize(p);
    return this.page(`WITH filtered AS (SELECT i.id AS "complaintId", i.branch_id AS "branchId", b.name AS branch,
      COALESCE(c.name, s.customer_name, 'Customer unavailable') AS customer, i.description AS "issueSummary", i.status,
      i.reported_at AS date, EXTRACT(EPOCH FROM (i.first_response_at - i.reported_at))::float AS "responseSeconds"
      FROM csat.incidents i JOIN core.branches b ON b.id = i.branch_id
      LEFT JOIN cim.customers c ON c.id = i.customer_id AND c.branch_id = i.branch_id AND c.deleted_at IS NULL
      LEFT JOIN srd.service_requests s ON s.id = i.service_request_id AND s.branch_id = i.branch_id AND s.deleted_at IS NULL
      WHERE ($1::uuid IS NULL OR i.branch_id = $1) AND ($2::text IS NULL OR $2 = 'all' OR i.status = $2)
        AND ($3::text IS NULL OR COALESCE(c.name, s.customer_name, '') ILIKE $3 OR i.description ILIKE $3 OR i.id::text ILIKE $3))
      SELECT (SELECT COUNT(*)::int FROM filtered) AS total,
        COALESCE((SELECT jsonb_agg(x) FROM (SELECT * FROM filtered ORDER BY date DESC, "complaintId" DESC LIMIT $4 OFFSET $5) x), '[]') AS rows`,
      [q.branchId ?? null, q.incidentStatus ?? null, q.search?.trim() ? `%${q.search.trim()}%` : null, q.limit, (q.page - 1) * q.limit]);
  }
}
