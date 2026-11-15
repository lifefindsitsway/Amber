import { Clock, Copy, MessageCircleQuestion, Play, Users } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { SegmentId } from "../../../shared/ids.ts";
import { useOptionalChatComposer, type QuoteDraft } from "../../chat/chat-composer.tsx";
import { explainSelectionQuestion, selectionForExplain, type ExplainableSelection } from "../../chat/selection-toolbar.tsx";
import { formatDuration } from "../../format.ts";
import { copyText } from "../../ui/clipboard.ts";
import { useContextMenuTarget, type MenuAction, type MenuHit } from "../../ui/context-menu.tsx";
import { useContentPage } from "./content-context.tsx";

/** What a sentence menu needs to know about the sentence, read from the view's own data. */
export interface SentenceData {
  text: string;
  startMs: number;
}

/** `[m:ss] text`: the timestamp in the same format the views show next to the sentence. */
export function sentenceWithTime(sentence: SentenceData): string {
  return `[${formatDuration(sentence.startMs)}] ${sentence.text}`;
}

/**
 * "Explain the selection" for a right click inside a selection the selection toolbar would
 * explain: the same text, question and (single-sentence) quote, from the region answering for
 * the selection when there is one, else from the page. Read when the menu is built, so the
 * action does not depend on the selection still being there.
 */
export function explainSelectionEntries(
  hit: MenuHit,
  t: TFunction,
  explain: (quote: QuoteDraft | undefined, question: string) => void,
): MenuAction[] {
  const selection = hit.selection;
  if (selection === undefined || selection.region === null) return [];
  const region = selection.region;
  const picked: ExplainableSelection | undefined =
    region === undefined ? selectionForExplain(window.getSelection()) : { text: region.text, ...(region.quote === undefined ? {} : { quote: region.quote }) };
  if (picked === undefined) return [];
  const question = explainSelectionQuestion(t, picked.text);
  return [
    {
      id: "explain-selection",
      label: t("common.menu.explainSelection"),
      icon: <MessageCircleQuestion size={14} aria-hidden="true" />,
      onSelect: () => explain(picked.quote, question),
    },
  ];
}

/**
 * Registers a sentence list (transcript reading view, subtitle rows, AI highlights) as one
 * context-menu object. The sentence is the nearest `[data-segment-id]` under the
 * pointer inside a view naming its revision with `data-revision-id`; between sentences the
 * list declines, so the browser menu stays. `sentenceOf` looks the sentence up in the view's
 * data at right-click time: the actions use that snapshot, never the DOM, because a windowed
 * row may unmount while the menu is open. Views whose rows cannot be selected (subtitles, AI
 * highlights) offer "explain this sentence"; the reading view explains a selection instead.
 * Off a sentence but inside a selection its region answers for (a chapter title, a gap, blank
 * space), the list offers the selection rows alone: the browser's own menu would copy only the
 * part of the selection the page holds.
 */
export function useSentenceMenu<T extends Element = HTMLElement>(
  sentenceOf: (segmentId: string) => SentenceData | undefined,
  options: {
    explainSentence: boolean;
    /** Plays from the sentence in the view's own way (it may keep state of its own); without it the page selects and seeks. */
    onPlay?: (segmentId: string) => void;
    /**
     * Present when the view reads by speakers: adds "copy this sentence with its speaker", the
     * text led by what this returns (`名字：`, empty for a sentence nobody was assigned to).
     */
    speakerPrefixOf?: (segmentId: string) => string;
  },
) {
  const { t } = useTranslation();
  const page = useContentPage();
  // Explaining needs the chat input; outside the content page the explain rows are left out.
  const composer = useOptionalChatComposer();
  return useContextMenuTarget<T>((hit) => {
    const explain = (draft: QuoteDraft | undefined, question: string): void => {
      composer?.explain(draft, question);
      window.getSelection()?.removeAllRanges();
    };
    const element = hit.target.closest<HTMLElement>("[data-segment-id]");
    const segmentId = element?.dataset["segmentId"];
    const revisionId = element?.closest<HTMLElement>("[data-revision-id]")?.dataset["revisionId"];
    if (segmentId === undefined || revisionId === undefined) {
      if (hit.selection?.region == null) return undefined;
      return { kind: "text", selectionEntries: composer === undefined ? [] : explainSelectionEntries(hit, t, explain), entries: [] };
    }
    const sentence = sentenceOf(segmentId);
    if (sentence === undefined) return undefined;
    const quote: QuoteDraft = { transcriptRevisionId: revisionId, segmentId: segmentId as SegmentId, text: sentence.text };
    // Read when the menu is built, like the sentence itself: the action does not depend on the view staying as it is.
    const speakerPrefix = options.speakerPrefixOf?.(segmentId);
    const selectionEntries = composer === undefined ? [] : explainSelectionEntries(hit, t, explain);
    return {
      kind: "text",
      selectionEntries,
      entries: [
        {
          id: "play-from-here",
          label: t("common.menu.playFromHere"),
          icon: <Play size={14} aria-hidden="true" />,
          onSelect: () => (options.onPlay === undefined ? page.select({ revisionId, segmentId }, sentence.startMs) : options.onPlay(segmentId)),
        },
        { id: "copy-sentence", label: t("common.menu.copySentence"), icon: <Copy size={14} aria-hidden="true" />, onSelect: () => void copyText(sentence.text) },
        {
          id: "copy-sentence-with-time",
          label: t("common.menu.copySentenceWithTime"),
          icon: <Clock size={14} aria-hidden="true" />,
          onSelect: () => void copyText(sentenceWithTime(sentence)),
        },
        ...(speakerPrefix === undefined
          ? []
          : [
              {
                id: "copy-sentence-with-speaker",
                label: t("speakerReader.copy.sentenceWithSpeaker"),
                icon: <Users size={14} aria-hidden="true" />,
                onSelect: () => void copyText(`${speakerPrefix}${sentence.text}`),
              },
            ]),
        ...(composer === undefined || !options.explainSentence
          ? []
          : [
              {
                id: "explain-sentence",
                label: t("common.menu.explainSentence"),
                icon: <MessageCircleQuestion size={14} aria-hidden="true" />,
                onSelect: () => explain(quote, t("chat.explainPrompt")),
              },
            ]),
      ],
    };
  });
}
