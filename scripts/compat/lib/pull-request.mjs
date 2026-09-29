// What open-pr.mjs sends to the repository, worked out without touching git or the network.
//
// One open pull request per package collects that package's results, on the branch
// `compat/<package>`. The branch is always the base branch plus exactly one commit, and that commit
// holds every result that is not on the base branch yet. A pull request per build would conflict with
// every other open one, because they all insert into the same object of the same file.
import { applyCell, emptyResults, tidyResults } from './record.mjs';

export const BRANCH_PREFIX = 'compat/';

// Characters of an npm name that git refuses in a ref, or refuses in some positions. `%` never
// appears in an npm name, so the escapes cannot be mistaken for name characters, and branchFor can be
// reversed (packageOfBranch): two packages never get the same branch.
const escape = (char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`;

function refComponent(part) {
  let out = part.replace(/~/g, escape);
  // A dot is kept where git allows it: not before another dot, not at the end, not in ".lock" at the end.
  out = out.replace(/\.(?=\.|$)/g, escape('.'));
  if (out.endsWith('.lock')) out = `${out.slice(0, -5)}${escape('.')}lock`;
  return out;
}

/** The branch that collects a package's results: `compat/react-native-screens`, `compat/@react-navigation/core`. */
export function branchFor(name) {
  return BRANCH_PREFIX + name.split('/').map(refComponent).join('/');
}

/** The package a branch belongs to: the reverse of branchFor. */
export function packageOfBranch(branch) {
  if (!branch.startsWith(BRANCH_PREFIX)) return null;
  return branch.slice(BRANCH_PREFIX.length).replace(/%([0-9a-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

const cellsOf = (file) =>
  Object.entries(file?.results ?? {}).flatMap(([libraryLine, row]) =>
    Object.entries(row).map(([reactNativeLine, cell]) => ({ libraryLine, reactNativeLine, cell })),
  );

/**
 * The package's results file as the branch should hold it: the base branch's file, then every cell
 * the branch already carries, then the new cell. A cell is replaced only by a newer one, so a result
 * the base branch has taken since (or a newer one from another build) is never overwritten by an older
 * one. Only lines the catalog lists are kept.
 * @param {object} options
 * @param {string} options.name  the package
 * @param {object | undefined} options.base  the base branch's results file, if it has one
 * @param {object | undefined} options.branch  the results file on the package's branch, if it exists and is valid
 * @param {{ libraryLine: string, reactNativeLine: string, cell: object }} options.result  the new cell
 * @param {string[]} options.libraryLines  the package's lines in the base branch's catalog
 * @param {string[]} options.reactNativeLines  the React Native lines in the base branch's catalog
 */
export function nextResultsFile({ name, base, branch, result, libraryLines, reactNativeLines }) {
  let file = structuredClone(base ?? emptyResults(name));
  for (const carried of cellsOf(branch)) file = applyCell(file, name, carried).file;
  file = applyCell(file, name, result).file;
  return tidyResults(file, libraryLines, reactNativeLines);
}

/** The cells of `next` that the base branch does not have, or has with other contents. */
export function changedCells(base, next) {
  return cellsOf(next).filter(({ libraryLine, reactNativeLine, cell }) => {
    const before = base?.results?.[libraryLine]?.[reactNativeLine];
    return JSON.stringify(before) !== JSON.stringify(cell);
  });
}

const plural = (n) => `${n} result${n === 1 ? '' : 's'}`;

/** Pull request title and commit message. */
export function titleFor(name, count) {
  return `compat: ${name}: ${plural(count)}`;
}

const STATUS = { compatible: 'Compatible', incompatible: 'Incompatible' };

/** The pull request description, generated from the cells each time. */
export function bodyFor(name, cells, base) {
  const rows = cells.map(({ cell }) =>
    [
      cell.tested.library,
      cell.tested.reactNative,
      STATUS[cell.status],
      cell.checks.buildIos,
      cell.checks.buildAndroid,
      cell.checks.tests,
      cell.testedAt,
      cell.buildUrl ? `[build](${cell.buildUrl})` : 'local run',
    ].join(' | '),
  );
  return [
    `Results of \`compatibility-check\` for \`${name}\` that \`${base}\` does not have yet.`,
    '',
    '| Library | React Native | Result | iOS build | Android build | Tests | Tested at | Build |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row} |`),
    '',
    'Each new result for this package is added to this pull request, and this description is written',
    'again from the data. If you close it without merging, delete the branch too; otherwise the next',
    'result carries these cells forward.',
    '',
  ].join('\n');
}
