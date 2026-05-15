const GROUP_LABEL = { concept: 'Concepts', person: 'People', source: 'Sources', query: 'Queries' };

export function renderIndexAdf({ siteUrl, spaceKey, groups }) {
  const content = [];
  for (const type of ['concept', 'person', 'source', 'query']) {
    const items = groups[type] ?? [];
    content.push({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: GROUP_LABEL[type] }] });
    if (items.length === 0) {
      content.push({ type: 'paragraph', content: [{ type: 'text', text: '(none)' }] });
      continue;
    }
    const listItems = items.map(it => ({
      type: 'listItem',
      content: [{
        type: 'paragraph',
        content: [
          { type: 'text', text: it.title, marks: [{ type: 'link', attrs: { href: `${siteUrl}/wiki/spaces/${spaceKey}/pages/${it.numericId}` } }] },
          ...(it.summary ? [{ type: 'text', text: ' — ' + it.summary }] : []),
        ],
      }],
    }));
    content.push({ type: 'bulletList', content: listItems });
  }
  return { type: 'doc', version: 1, content };
}
