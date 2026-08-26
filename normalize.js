// 최초 1회 정규화 (스펙 §2.1) — experiment.js 의 preserve() 와 같은 처리.
// 여기서는 md.js 의 parser/writer 와 convert.js 가 이미 아는 BLOCK_KNOWN 을 그대로 재사용한다.
import { parser, writer } from './md.js';
import { BLOCK_KNOWN } from './convert.js';

export function preserveTopLevel(text) {
  const tree = parser.parse(text);
  tree.children = tree.children.map((node) =>
    BLOCK_KNOWN.has(node.type)
      ? node
      : { type: 'raw', value: text.slice(node.position.start.offset, node.position.end.offset) });
  return writer.stringify(tree);
}

export const hasCRLF = (s) => s.includes('\r\n');
export const toLF = (s) => s.replace(/\r\n/g, '\n');
export const toCRLF = (s) => s.replace(/\n/g, '\r\n');
