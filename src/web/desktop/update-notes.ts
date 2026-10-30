/**
 * Release notes as the update card lays them out. The notes come from the update feed and are
 * shown as text only: a line followed by bullet lines (or a Markdown heading) titles a section,
 * bullet lines (`• `, `- `, `* `, `+ `) are its items, and any other line is a paragraph.
 * Emphasis and code marks are dropped; links, images and HTML are never interpreted.
 */
export type UpdateNotesBlock = { kind: "paragraph"; text: string } | { kind: "section"; title?: string; items: string[] };

const HEADING = /^#{1,6}\s+(.*?)\s*#*$/u;
const BULLET = /^[•·\-*+]\s+(.*)$/u;

export function parseUpdateNotes(notes: string): UpdateNotesBlock[] {
  const lines = notes.split(/\r?\n/u).map((line) => line.trim());
  const blocks: UpdateNotesBlock[] = [];
  let section: { kind: "section"; title?: string; items: string[] } | undefined;
  lines.forEach((line, index) => {
    if (line === "") return;
    const heading = HEADING.exec(line);
    const bullet = BULLET.exec(line);
    if (heading !== null) {
      section = { kind: "section", title: plain(heading[1] as string), items: [] };
      blocks.push(section);
    } else if (bullet !== null) {
      if (section === undefined) {
        section = { kind: "section", items: [] };
        blocks.push(section);
      }
      section.items.push(plain(bullet[1] as string));
    } else if (BULLET.test(lines[index + 1] ?? "")) {
      section = { kind: "section", title: plain(line), items: [] };
      blocks.push(section);
    } else {
      section = undefined;
      blocks.push({ kind: "paragraph", text: plain(line) });
    }
  });
  return blocks;
}

function plain(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/gu, "$1").replace(/`([^`]+)`/gu, "$1");
}
