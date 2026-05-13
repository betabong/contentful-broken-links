import type { CMAClient } from '@contentful/app-sdk';

export type BrokenReason = 'deleted' | 'unpublished' | 'archived';

export type BrokenLink = {
  entryId: string;
  entryContentTypeId: string;
  entryTitle?: string;
  entryUpdatedAt: string;
  fieldId: string;
  inArray: boolean;
  locale: string;
  linkType: 'Entry' | 'Asset';
  targetId: string;
  reason: BrokenReason;
  resolved?: boolean;
};

export type ScanProgress = {
  phase: string;
  current: number;
  total: number;
};

export type ScanCallbacks = {
  onProgress: (p: ScanProgress) => void;
  onResult: (link: BrokenLink) => void;
  isCancelled?: () => boolean;
};

export type RecheckResult =
  | { entryId: string; status: 'gone' }
  | { entryId: string; status: 'unpublished' }
  | { entryId: string; status: 'ok'; brokenLinks: BrokenLink[] };

type LinkFieldMeta = {
  fieldId: string;
  linkType: 'Entry' | 'Asset';
  isArray: boolean;
};

type ContentTypeMeta = {
  displayField?: string | null;
  fields: LinkFieldMeta[];
};

type LinkValue = { sys?: { id?: string; linkType?: string } };

type TargetState = {
  publishedVersion?: number;
  archivedVersion?: number;
} | null;

type Ref = Omit<BrokenLink, 'reason'>;

const ENTRY_PAGE_SIZE = 100;
const ID_BATCH_SIZE = 100;

export async function scanBrokenLinks(
  cma: CMAClient,
  { onProgress, onResult, isCancelled }: ScanCallbacks,
): Promise<void> {
  onProgress({ phase: 'Loading content types', current: 0, total: 0 });
  const meta = await loadRequiredLinkFields(cma);
  const ctIds = Array.from(meta.keys());
  if (ctIds.length === 0) {
    onProgress({ phase: 'No required link fields in this space', current: 0, total: 0 });
    return;
  }

  const entryState = new Map<string, TargetState>();
  const assetState = new Map<string, TargetState>();

  let skip = 0;
  let total = Infinity;
  let processed = 0;

  while (skip < total) {
    if (isCancelled?.()) return;

    const res = await cma.entry.getMany({
      query: {
        'sys.publishedAt[exists]': true,
        'sys.contentType.sys.id[in]': ctIds.join(','),
        order: '-sys.updatedAt',
        skip,
        limit: ENTRY_PAGE_SIZE,
      },
    });
    total = res.total;
    onProgress({
      phase: 'Scanning published entries (newest first)',
      current: processed,
      total,
    });

    const pageRefs: Ref[] = [];
    for (const entry of res.items) {
      const ctMeta = meta.get(entry.sys.contentType.sys.id);
      if (!ctMeta) continue;
      pageRefs.push(...collectRefsFromEntry(entry, ctMeta));
    }

    if (pageRefs.length > 0) {
      const newEntryIds = uniqMissing(pageRefs, 'Entry', entryState);
      const newAssetIds = uniqMissing(pageRefs, 'Asset', assetState);
      await resolveStates(cma, newEntryIds, 'Entry', entryState, isCancelled);
      await resolveStates(cma, newAssetIds, 'Asset', assetState, isCancelled);

      for (const ref of pageRefs) {
        const state =
          ref.linkType === 'Entry'
            ? entryState.get(ref.targetId)
            : assetState.get(ref.targetId);
        const reason = classify(state);
        if (reason) onResult({ ...ref, reason });
      }
    }

    processed += res.items.length;
    skip += res.items.length;
    onProgress({
      phase: 'Scanning published entries (newest first)',
      current: processed,
      total,
    });
    if (res.items.length === 0) break;
  }
}

export async function recheckEntry(
  cma: CMAClient,
  entryId: string,
): Promise<RecheckResult> {
  let entry: EntryLike;
  try {
    entry = (await cma.entry.get({ entryId })) as unknown as EntryLike;
  } catch (err) {
    if (isNotFound(err)) return { entryId, status: 'gone' };
    throw err;
  }
  if (!entry.sys.publishedVersion) return { entryId, status: 'unpublished' };

  const ctId = entry.sys.contentType.sys.id;
  const ct = (await cma.contentType.get({ contentTypeId: ctId })) as unknown as ContentTypeLike;
  const linkFields = extractRequiredLinkFields(ct);
  if (linkFields.length === 0) return { entryId, status: 'ok', brokenLinks: [] };

  const ctMeta: ContentTypeMeta = {
    displayField: ct.displayField,
    fields: linkFields,
  };
  const refs = collectRefsFromEntry(entry, ctMeta);
  if (refs.length === 0) return { entryId, status: 'ok', brokenLinks: [] };

  const entryState = new Map<string, TargetState>();
  const assetState = new Map<string, TargetState>();
  const entryIds = uniqByType(refs, 'Entry');
  const assetIds = uniqByType(refs, 'Asset');
  await resolveStates(cma, entryIds, 'Entry', entryState);
  await resolveStates(cma, assetIds, 'Asset', assetState);

  const broken: BrokenLink[] = [];
  for (const ref of refs) {
    const state =
      ref.linkType === 'Entry'
        ? entryState.get(ref.targetId)
        : assetState.get(ref.targetId);
    const reason = classify(state);
    if (reason) broken.push({ ...ref, reason });
  }
  return { entryId, status: 'ok', brokenLinks: broken };
}

type EntryLike = {
  sys: {
    id: string;
    updatedAt: string;
    publishedVersion?: number;
    contentType: { sys: { id: string } };
  };
  fields: Record<string, Record<string, unknown>>;
};

type ContentTypeLike = {
  sys: { id: string };
  displayField?: string | null;
  fields: Array<{
    id: string;
    type: string;
    required?: boolean;
    omitted?: boolean;
    linkType?: string;
    items?: { type: string; linkType?: string };
  }>;
};

function collectRefsFromEntry(entry: EntryLike, ctMeta: ContentTypeMeta): Ref[] {
  const out: Ref[] = [];
  const ctId = entry.sys.contentType.sys.id;
  const titleVal = ctMeta.displayField ? entry.fields[ctMeta.displayField] : undefined;
  const firstTitle = titleVal ? Object.values(titleVal)[0] : undefined;
  const entryTitle = typeof firstTitle === 'string' ? firstTitle : undefined;

  for (const lf of ctMeta.fields) {
    const byLocale = entry.fields[lf.fieldId];
    if (!byLocale) continue;
    for (const [locale, value] of Object.entries(byLocale)) {
      if (value == null) continue;
      if (lf.isArray) {
        if (!Array.isArray(value)) continue;
        for (const item of value as LinkValue[]) {
          const id = item?.sys?.id;
          if (id) {
            out.push(makeRef(entry, ctId, entryTitle, lf, true, locale, id));
          }
        }
      } else {
        const id = (value as LinkValue)?.sys?.id;
        if (id) {
          out.push(makeRef(entry, ctId, entryTitle, lf, false, locale, id));
        }
      }
    }
  }
  return out;
}

function makeRef(
  entry: EntryLike,
  ctId: string,
  entryTitle: string | undefined,
  lf: LinkFieldMeta,
  inArray: boolean,
  locale: string,
  targetId: string,
): Ref {
  return {
    entryId: entry.sys.id,
    entryContentTypeId: ctId,
    entryTitle,
    entryUpdatedAt: entry.sys.updatedAt,
    fieldId: lf.fieldId,
    inArray,
    locale,
    linkType: lf.linkType,
    targetId,
  };
}

function uniqByType(refs: Ref[], linkType: 'Entry' | 'Asset'): string[] {
  const out = new Set<string>();
  for (const r of refs) if (r.linkType === linkType) out.add(r.targetId);
  return Array.from(out);
}

function uniqMissing(
  refs: Ref[],
  linkType: 'Entry' | 'Asset',
  cache: Map<string, TargetState>,
): string[] {
  const out = new Set<string>();
  for (const r of refs) {
    if (r.linkType === linkType && !cache.has(r.targetId)) out.add(r.targetId);
  }
  return Array.from(out);
}

function extractRequiredLinkFields(ct: ContentTypeLike): LinkFieldMeta[] {
  const linkFields: LinkFieldMeta[] = [];
  for (const f of ct.fields) {
    if (f.omitted) continue;
    if (!f.required) continue;
    if (f.type === 'Link' && (f.linkType === 'Entry' || f.linkType === 'Asset')) {
      linkFields.push({ fieldId: f.id, linkType: f.linkType, isArray: false });
    } else if (
      f.type === 'Array' &&
      f.items?.type === 'Link' &&
      (f.items.linkType === 'Entry' || f.items.linkType === 'Asset')
    ) {
      linkFields.push({ fieldId: f.id, linkType: f.items.linkType, isArray: true });
    }
  }
  return linkFields;
}

async function loadRequiredLinkFields(
  cma: CMAClient,
): Promise<Map<string, ContentTypeMeta>> {
  const result = new Map<string, ContentTypeMeta>();
  let skip = 0;
  while (true) {
    const res = await cma.contentType.getMany({ query: { skip, limit: 100 } });
    for (const ct of res.items as unknown as ContentTypeLike[]) {
      const linkFields = extractRequiredLinkFields(ct);
      if (linkFields.length > 0) {
        result.set(ct.sys.id, { displayField: ct.displayField, fields: linkFields });
      }
    }
    skip += res.items.length;
    if (res.items.length === 0 || skip >= res.total) break;
  }
  return result;
}

async function resolveStates(
  cma: CMAClient,
  ids: string[],
  kind: 'Entry' | 'Asset',
  cache: Map<string, TargetState>,
  isCancelled?: () => boolean,
): Promise<void> {
  if (ids.length === 0) return;

  const remaining = new Set(ids);
  for (const batch of chunk(ids, ID_BATCH_SIZE)) {
    if (isCancelled?.()) return;
    const items = await fetchByIds(cma, kind, batch, false);
    for (const item of items) {
      cache.set(item.sys.id, {
        publishedVersion: item.sys.publishedVersion,
        archivedVersion: item.sys.archivedVersion,
      });
      remaining.delete(item.sys.id);
    }
  }

  const archivedCandidates = Array.from(remaining);
  for (const batch of chunk(archivedCandidates, ID_BATCH_SIZE)) {
    if (isCancelled?.()) return;
    const items = await fetchByIds(cma, kind, batch, true);
    for (const item of items) {
      cache.set(item.sys.id, {
        publishedVersion: item.sys.publishedVersion,
        archivedVersion: item.sys.archivedVersion ?? 1,
      });
      remaining.delete(item.sys.id);
    }
  }

  for (const id of remaining) cache.set(id, null);
}

async function fetchByIds(
  cma: CMAClient,
  kind: 'Entry' | 'Asset',
  ids: string[],
  archived: boolean,
): Promise<Array<{ sys: { id: string; publishedVersion?: number; archivedVersion?: number } }>> {
  if (ids.length === 0) return [];
  const query: Record<string, unknown> = {
    'sys.id[in]': ids.join(','),
    limit: ids.length,
  };
  if (archived) query['sys.archivedAt[exists]'] = true;
  const res =
    kind === 'Entry'
      ? await cma.entry.getMany({ query })
      : await cma.asset.getMany({ query });
  return res.items as Array<{
    sys: { id: string; publishedVersion?: number; archivedVersion?: number };
  }>;
}

function classify(state: TargetState | undefined): BrokenReason | null {
  if (state === undefined || state === null) return 'deleted';
  if (state.archivedVersion) return 'archived';
  if (!state.publishedVersion) return 'unpublished';
  return null;
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: number; statusCode?: number; name?: string };
  return e.status === 404 || e.statusCode === 404 || e.name === 'NotFound';
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
