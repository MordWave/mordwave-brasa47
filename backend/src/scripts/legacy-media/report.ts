import type { Plan, PlanItem } from './types.js';

// Human-readable inventory. Ids, storage paths and statuses only — no URLs,
// no hosts, no credentials.
export function renderReport(plan: Plan, supabaseObjects: string[] | null): string {
  const lines: string[] = [];
  const by = (status: PlanItem['status']) => plan.items.filter((i) => i.status === status);
  lines.push(`database: ${plan.database} | supabase bucket: ${plan.supabaseBucket} | plan hash: ${plan.planHash}`);
  lines.push(`rows inventoried: ${plan.items.length}`);
  for (const status of [
    'to_migrate',
    'skipped_already_migrated',
    'skipped_no_image',
    'skipped_not_supabase',
    'skipped_deleted',
    'anomaly',
  ] as const) {
    lines.push(`  ${status}: ${by(status).length}`);
  }
  lines.push('');
  lines.push('to_migrate:');
  for (const i of by('to_migrate')) {
    lines.push(`  ${i.id}  ${i.objectPath}  ${i.sourceSize} bytes  sha256=${i.sourceSha256?.slice(0, 12)}…  -> ${i.destinationKey}`);
  }
  lines.push('already migrated (skipped, legacy URL kept as rollback where present):');
  for (const i of by('skipped_already_migrated')) {
    lines.push(`  ${i.id}  legacyUrl=${i.hasLegacyUrl ? 'kept' : 'none'}`);
  }
  if (by('skipped_not_supabase').length || by('anomaly').length || by('skipped_deleted').length) {
    lines.push('needs attention:');
    for (const i of [...by('skipped_not_supabase'), ...by('anomaly'), ...by('skipped_deleted')]) {
      lines.push(`  ${i.id}  ${i.status}${i.reason ? ` (${i.reason})` : ''}`);
    }
  }
  if (supabaseObjects) {
    const referenced = new Set(plan.items.map((i) => i.objectPath).filter(Boolean));
    const orphans = supabaseObjects.filter((o) => !referenced.has(o));
    lines.push('');
    lines.push(`supabase objects: ${supabaseObjects.length} | referenced by a row: ${supabaseObjects.length - orphans.length} | orphans: ${orphans.length}`);
    for (const o of orphans) lines.push(`  orphan: ${o}`);
  }
  return lines.join('\n');
}
