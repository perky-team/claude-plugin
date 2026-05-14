export function createFsDestination({ rootPath }) {
  const notImpl = () => { throw new Error('not implemented yet'); };
  return {
    kind: 'fs',
    rootPath,
    pageExists: notImpl,
    readPage: notImpl,
    writePage: notImpl,
    mutatePage: notImpl,
    movePage: notImpl,
    listPages: notImpl,
    search: notImpl,
    lint: notImpl,
  };
}
