import { createFsDestination } from './destinations/fs.mjs';

function buildDestination({ root, name, block }) {
  if (block.kind === 'fs') return createFsDestination({ root, name });
  // jira branch — added in Task 26
  throw new Error(`unsupported destination kind: ${block.kind}`);
}

export function resolveDestination({ root, config }) {
  const primaryName = config.primary;
  const primaryBlock = config.destinations[primaryName];
  const primary = buildDestination({ root, name: primaryName, block: primaryBlock });

  const mirrorNames = config.mirrors ?? [];
  const mirrors = mirrorNames.map(n =>
    buildDestination({ root, name: n, block: config.destinations[n] }),
  );

  return { primary, primaryName, mirrors, mirrorNames };
}
