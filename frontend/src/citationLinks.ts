import type { Root, RootContent, Text } from 'mdast';

export function citationNumberFromHref(href?: string) {
  const match = /^[^#]*#evidence-(\d+)$/.exec(href ?? '');
  return match ? Number(match[1]) : undefined;
}

// Older answers may contain plain citation markers. Only link numbers stored
// with this answer, and never turn code or an existing link into a citation.
export function remarkCitationLinks(numbers: ReadonlySet<number>, draft = false) {
  return (tree: Root) => {
    function walk(node: Root | RootContent) {
      if (node.type === 'link' || node.type === 'linkReference' || !('children' in node)) return;
      const children = node.children as RootContent[];
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        if (child.type !== 'text') {
          walk(child);
          continue;
        }
        const parts: RootContent[] = [];
        let cursor = 0;
        for (const marker of child.value.matchAll(/\[(?:ID:|证据\s*)?([1-9]\d*)\]|【(?:证据\s*)?([1-9]\d*)】/g)) {
          const number = Number(marker[1] ?? marker[2]);
          const explicitMarker = /^\[(?:ID:|证据)|^【证据/.test(marker[0]);
          if (!numbers.has(number) && !(draft || explicitMarker)) continue;
          const leading = child.value.slice(cursor, marker.index);
          if (leading) parts.push({ type: 'text', value: leading });
          if (numbers.has(number)) {
            const label: Text = { type: 'text', value: `[${number}]` };
            parts.push({ type: 'link', url: `#evidence-${number}`, children: [label] });
          }
          cursor = marker.index + marker[0].length;
        }
        if (!cursor) continue;
        if (cursor < child.value.length) parts.push({ type: 'text', value: child.value.slice(cursor) });
        children.splice(index, 1, ...parts);
      }

      // A citation can recur later in the answer. Deduplicate only within a
      // contiguous group of citations attached to the same statement.
      const seen = new Set<number>();
      let separator: RootContent | undefined;
      const deduplicated: RootContent[] = [];
      for (const child of children) {
        const number = child.type === 'link' ? citationNumberFromHref(child.url) : undefined;
        if (number !== undefined && numbers.has(number)) {
          if (!seen.has(number)) {
            if (separator) deduplicated.push(separator);
            deduplicated.push(child);
            seen.add(number);
          }
          separator = undefined;
        } else if (seen.size && child.type === 'text' && /^[ \t,，、]+$/.test(child.value) && !separator) {
          separator = child;
        } else {
          if (separator) deduplicated.push(separator);
          separator = undefined;
          seen.clear();
          deduplicated.push(child);
        }
      }
      if (separator) deduplicated.push(separator);
      children.splice(0, children.length, ...deduplicated);
    }
    walk(tree);
  };
}
