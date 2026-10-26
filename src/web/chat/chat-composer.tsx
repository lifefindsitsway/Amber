import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { ChatQuote } from "../../shared/dto/chat.ts";

/** A quoted sentence waiting in the input, with its text for the card. */
export interface QuoteDraft extends ChatQuote {
  text: string;
}

export interface ComposerState {
  quote: QuoteDraft | undefined;
  /** Text to put into the input; `seq` changes on every request so the same text can be asked twice. */
  prefill: { text: string; seq: number } | undefined;
}

/**
 * The hand-over from the selection toolbar to the chat input: "explain" attaches a quote
 * and pre-fills a question, and the user still decides to send it (Human-first).
 */
export class ChatComposer {
  private state: ComposerState = { quote: undefined, prefill: undefined };
  private seq = 0;
  private readonly listeners = new Set<() => void>();

  snapshot = (): ComposerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Pre-fills `question`; without a quote any earlier one is dropped, so it is not sent along. */
  explain(quote: QuoteDraft | undefined, question: string): void {
    this.seq += 1;
    this.set({ quote, prefill: { text: question, seq: this.seq } });
  }

  clearQuote(): void {
    this.set({ ...this.state, quote: undefined });
  }

  /** Puts back the quote a thread's draft had, without pre-filling the input again. */
  restoreQuote(quote: QuoteDraft | undefined): void {
    this.set({ ...this.state, quote });
  }

  private set(next: ComposerState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const Context = createContext<ChatComposer | undefined>(undefined);

export function ChatComposerProvider(props: { composer: ChatComposer; children: ReactNode }) {
  return <Context.Provider value={props.composer}>{props.children}</Context.Provider>;
}

export function useChatComposer(): ChatComposer {
  const composer = useContext(Context);
  if (composer === undefined) {
    throw new Error("ChatComposerProvider missing");
  }
  return composer;
}

/** The composer when one is mounted; views also rendered outside the content page use this. */
export function useOptionalChatComposer(): ChatComposer | undefined {
  return useContext(Context);
}

export function useComposerState(): ComposerState {
  const composer = useChatComposer();
  return useSyncExternalStore(composer.subscribe, composer.snapshot);
}
