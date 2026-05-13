import { useMemo, useRef, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  FormControl,
  Heading,
  Note,
  Paragraph,
  Spinner,
  Stack,
  Table,
  Text,
  TextLink,
} from '@contentful/f36-components';
import type { PageAppSDK } from '@contentful/app-sdk';
import { useCMA, useSDK } from '@contentful/react-apps-toolkit';
import {
  scanBrokenLinks,
  type BrokenLink,
  type BrokenReason,
  type ScanProgress,
} from '../lib/scan';

const REASON_VARIANT: Record<BrokenReason, 'negative' | 'warning' | 'primary'> = {
  deleted: 'negative',
  archived: 'warning',
  unpublished: 'primary',
};

export default function Page() {
  const sdk = useSDK<PageAppSDK>();
  const cma = useCMA();

  const [scanning, setScanning] = useState(false);
  const [hasRun, setHasRun] = useState(false);
  const [results, setResults] = useState<BrokenLink[]>([]);
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ignoreArrayDraft, setIgnoreArrayDraft] = useState(false);
  const [ignoreArrayMissing, setIgnoreArrayMissing] = useState(false);
  const cancelRef = useRef(false);

  const isIgnored = (b: BrokenLink) => {
    if (!b.inArray) return false;
    if (ignoreArrayDraft && b.reason === 'unpublished') return true;
    if (ignoreArrayMissing && (b.reason === 'deleted' || b.reason === 'archived')) {
      return true;
    }
    return false;
  };

  const visibleResults = useMemo(
    () => results.filter((b) => !isIgnored(b)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, ignoreArrayDraft, ignoreArrayMissing],
  );
  const ignoredCount = results.length - visibleResults.length;

  const summary = useMemo(() => {
    const counts: Record<BrokenReason, number> = {
      deleted: 0,
      archived: 0,
      unpublished: 0,
    };
    for (const r of visibleResults) counts[r.reason]++;
    return counts;
  }, [visibleResults]);

  const runScan = async () => {
    cancelRef.current = false;
    setScanning(true);
    setHasRun(true);
    setError(null);
    setResults([]);
    setProgress({ phase: 'Starting…', current: 0, total: 0 });
    try {
      await scanBrokenLinks(cma, {
        onProgress: (p) => setProgress(p),
        onResult: (link) => setResults((prev) => [...prev, link]),
        isCancelled: () => cancelRef.current,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
      setProgress(null);
    }
  };

  const stopScan = () => {
    cancelRef.current = true;
  };

  return (
    <Box padding="spacingXl" style={{ maxWidth: 1200, margin: '0 auto' }}>
      <Stack flexDirection="column" alignItems="flex-start" spacing="spacingM">
        <Heading>Broken Links</Heading>
        <Paragraph>
          Scans <strong>currently-published</strong> entries from newest to oldest
          (by <code>sys.updatedAt</code>) and streams broken{' '}
          <strong>required link fields</strong> as they're found — targets that are
          deleted, archived, or unpublished. Optional link fields are not checked.
        </Paragraph>

        <FormControl as="fieldset">
          <FormControl.Label as="legend">
            Tolerate broken items inside link <em>arrays</em>
          </FormControl.Label>
          <Stack flexDirection="column" alignItems="flex-start" spacing="spacing2Xs">
            <Checkbox
              isChecked={ignoreArrayDraft}
              onChange={(e) => setIgnoreArrayDraft(e.target.checked)}
            >
              Ignore unpublished (draft) items in arrays
            </Checkbox>
            <Checkbox
              isChecked={ignoreArrayMissing}
              onChange={(e) => setIgnoreArrayMissing(e.target.checked)}
            >
              Ignore deleted or archived items in arrays
            </Checkbox>
          </Stack>
          <FormControl.HelpText>
            Required single-link fields are always reported — only items inside{' '}
            <code>Array&lt;Link&gt;</code> fields are filtered.
          </FormControl.HelpText>
        </FormControl>

        <Flex gap="spacingM" alignItems="center" flexWrap="wrap">
          {!scanning ? (
            <Button variant="primary" onClick={runScan}>
              {hasRun ? 'Re-scan space' : 'Scan space'}
            </Button>
          ) : (
            <Button variant="negative" onClick={stopScan}>
              Stop
            </Button>
          )}
          {scanning && progress && (
            <Flex alignItems="center" gap="spacingS">
              <Spinner />
              <Text>
                {progress.phase}
                {progress.total > 0
                  ? ` — ${progress.current} / ${progress.total} entries`
                  : ''}
              </Text>
            </Flex>
          )}
          {hasRun && (
            <Text fontColor="gray600">
              {visibleResults.length} broken{' '}
              {visibleResults.length === 1 ? 'link' : 'links'}
              {summary.deleted > 0 && ` · ${summary.deleted} deleted`}
              {summary.archived > 0 && ` · ${summary.archived} archived`}
              {summary.unpublished > 0 && ` · ${summary.unpublished} unpublished`}
              {ignoredCount > 0 && ` · ${ignoredCount} ignored`}
            </Text>
          )}
        </Flex>

        {error && (
          <Note variant="negative" style={{ width: '100%' }}>
            {error}
          </Note>
        )}

        {hasRun && !scanning && visibleResults.length === 0 && !error && (
          <Note variant="positive" style={{ width: '100%' }}>
            {ignoredCount > 0
              ? `No reportable broken links — ${ignoredCount} ignored by current filters.`
              : 'No broken required links found across published entries.'}
          </Note>
        )}

        {visibleResults.length > 0 && (
          <Box style={{ width: '100%' }}>
            <Table>
              <Table.Head>
                <Table.Row>
                  <Table.Cell>Entry</Table.Cell>
                  <Table.Cell>Updated</Table.Cell>
                  <Table.Cell>Content type</Table.Cell>
                  <Table.Cell>Field</Table.Cell>
                  <Table.Cell>Locale</Table.Cell>
                  <Table.Cell>Target</Table.Cell>
                  <Table.Cell>Reason</Table.Cell>
                </Table.Row>
              </Table.Head>
              <Table.Body>
                {visibleResults.map((b, i) => (
                  <Table.Row
                    key={`${b.entryId}-${b.fieldId}-${b.locale}-${b.targetId}-${i}`}
                  >
                    <Table.Cell>
                      <TextLink
                        as="button"
                        onClick={() =>
                          sdk.navigator.openEntry(b.entryId, { slideIn: true })
                        }
                      >
                        {b.entryTitle || b.entryId}
                      </TextLink>
                    </Table.Cell>
                    <Table.Cell>
                      <Text fontColor="gray600">
                        {formatDate(b.entryUpdatedAt)}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <code>{b.entryContentTypeId}</code>
                    </Table.Cell>
                    <Table.Cell>
                      <code>{b.fieldId}</code>
                    </Table.Cell>
                    <Table.Cell>{b.locale}</Table.Cell>
                    <Table.Cell>
                      <TextLink
                        as="button"
                        onClick={() => openTarget(sdk, b.linkType, b.targetId)}
                      >
                        {b.linkType}: <code>{b.targetId}</code>
                      </TextLink>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge variant={REASON_VARIANT[b.reason]}>{b.reason}</Badge>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </Box>
        )}
      </Stack>
    </Box>
  );
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function openTarget(sdk: PageAppSDK, linkType: 'Entry' | 'Asset', id: string) {
  const opts = { slideIn: true } as const;
  const p =
    linkType === 'Entry'
      ? sdk.navigator.openEntry(id, opts)
      : sdk.navigator.openAsset(id, opts);
  Promise.resolve(p).catch(() => {
    /* deleted targets can't be opened */
  });
}
