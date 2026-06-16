import { findCycle } from './cycles.mjs';

function mappedKeyFor(srcItem, src, mirror) {
  // FS primary → Jira mirror: srcItem.jiraKeys[mirror.name]
  if (src.kind === 'fs' && mirror.kind === 'jira') return srcItem.jiraKeys?.[mirror.name];
  // Jira primary → FS mirror: Jira key becomes the FS id
  if (src.kind === 'jira' && mirror.kind === 'fs') return srcItem.id;
  // FS → FS or Jira → Jira: identity by id
  return srcItem.id;
}

function counterTemplate(name, kind) {
  return { mirror: name, kind, created: 0, updated: 0, linksAdded: 0, linksRemoved: 0, warnings: [], errors: [] };
}

// Build a patch containing ONLY the fields that actually changed. Sending the
// full {title, description, status} on every diff makes the Jira mirror re-assert
// an unchanged status, which has no transition and would throw — so a title-only
// edit must not carry status along. Descriptions are compared trimmed because
// Jira round-trips them through ADF and trims, which would otherwise churn.
function buildFieldPatch(existing, candidate) {
  const desc = (v) => (v ?? '').trim();
  const patch = {};
  if (existing.title !== candidate.title) patch.title = candidate.title;
  if (desc(existing.description) !== desc(candidate.description)) patch.description = candidate.description;
  if (existing.status !== candidate.status) patch.status = candidate.status;
  return patch;
}

export async function syncAll({ primary, primaryName, mirrors, mirrorNames }) {
  // Pass 1: read primary once — primary-side errors abort everything (propagate out)
  const srcItems = await primary.listItems();

  // Cycle check on Jira-primary
  if (primary.kind === 'jira') {
    const cycle = findCycle(srcItems.map(i => ({ id: i.id, blockedBy: i.blockedBy })));
    if (cycle) throw Object.assign(new Error(`cycle-detected on primary: ${cycle.join(' → ')}`), { code: 'cycle-detected' });
  }

  const results = [];
  for (let mi = 0; mi < mirrors.length; mi++) {
    const mirror = mirrors[mi];
    const counters = counterTemplate(mirrorNames[mi], mirror.kind);
    try {
      // Pass 2: ensure mirror structure
      await mirror.ensureStructure();

      // Pass 0: read mirror state
      const dstItems = await mirror.listItems();
      const dstByKey = new Map(dstItems.map(i => [i.id, i]));

      const srcToDstId = new Map(); // src.id → dst.id
      const dstCurrentById = new Map(); // dst.id → current mirror item (for pass 4)

      // Resolve a previously-mirrored item by its mapped key. mirror.listItems()
      // (Jira JQL search) is eventually consistent and may omit an issue created
      // moments ago, which would make sync re-create it (duplicate) every run.
      // When we already hold a mapped key, confirm the item by key (read-your-
      // writes) before deciding it's missing.
      async function resolveExisting(mappedKey) {
        if (!mappedKey) return undefined;
        const hit = dstByKey.get(mappedKey);
        if (hit) return hit;
        if (!mirror.readItem) return undefined;
        try { return await mirror.readItem(mappedKey); }
        catch (e) { if (e?.code === 'item-not-found') return undefined; throw e; }
      }

      // Pass 3a: tasks (type === 'task')
      for (const s of srcItems.filter(i => i.type === 'task')) {
        const mappedKey = mappedKeyFor(s, primary, mirror);
        const existing = await resolveExisting(mappedKey);
        if (existing) {
          const patch = buildFieldPatch(existing, s);
          if (Object.keys(patch).length > 0) {
            await mirror.updateItem(existing.id, patch);
            counters.updated++;
          }
          srcToDstId.set(s.id, existing.id);
          dstCurrentById.set(existing.id, existing);
        } else {
          const created = await mirror.createItem({
            type: 'task',
            title: s.title,
            description: s.description,
            status: s.status,
          });
          srcToDstId.set(s.id, created.id);
          dstCurrentById.set(created.id, { ...created, blockedBy: [] });
          counters.created++;
          if (primary.kind === 'fs' && mirror.kind === 'jira') {
            await primary.updateItem(s.id, { jiraKeys: { [mirror.name]: created.id } });
          }
        }
      }

      // Pass 3b: sub-tasks (type === 'sub-task')
      for (const s of srcItems.filter(i => i.type === 'sub-task')) {
        const mappedKey = mappedKeyFor(s, primary, mirror);
        const existing = await resolveExisting(mappedKey);
        const dstParentId = srcToDstId.get(s.parentId);
        if (existing) {
          const patch = buildFieldPatch(existing, s);
          if (Object.keys(patch).length > 0) {
            await mirror.updateItem(existing.id, patch);
            counters.updated++;
          }
          srcToDstId.set(s.id, existing.id);
          dstCurrentById.set(existing.id, existing);
        } else {
          const created = await mirror.createItem({
            type: 'sub-task',
            parentId: dstParentId,
            title: s.title,
            description: s.description,
            status: s.status,
          });
          srcToDstId.set(s.id, created.id);
          dstCurrentById.set(created.id, { ...created, blockedBy: [] });
          counters.created++;
          if (primary.kind === 'fs' && mirror.kind === 'jira') {
            await primary.updateItem(s.id, { jiraKeys: { [mirror.name]: created.id } });
          }
        }
      }

      // Pass 4: blockers
      for (const s of srcItems) {
        const dstId = srcToDstId.get(s.id);
        if (!dstId) continue;
        const targetBlockedBy = (s.blockedBy ?? [])
          .map(b => srcToDstId.get(b))
          .filter(Boolean);
        // Current mirror blocker state (read-your-writes, from pass 3); newly
        // created items start with none.
        const before = (dstCurrentById.get(dstId)?.blockedBy ?? []);
        const beforeSet = new Set(before);
        const afterSet = new Set(targetBlockedBy);
        // Only update if the blocker list actually changed
        const same =
          beforeSet.size === afterSet.size &&
          [...afterSet].every(t => beforeSet.has(t));
        if (!same) {
          // A blockedBy patch only adds/removes links — it never transitions
          // status — so any failure here is a real error; let it propagate to
          // the mirror-level handler below.
          await mirror.updateItem(dstId, { blockedBy: targetBlockedBy });
          for (const t of afterSet) if (!beforeSet.has(t)) counters.linksAdded++;
          for (const t of beforeSet) if (!afterSet.has(t)) counters.linksRemoved++;
        }
      }
    } catch (e) {
      counters.errors.push({ code: e?.code ?? 'internal', message: e?.message ?? String(e) });
    }
    results.push(counters);
  }
  return results;
}
