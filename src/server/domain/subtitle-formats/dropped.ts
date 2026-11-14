import { graphemesOf } from "../../../shared/speakers.ts";

/** A preview names only a few dropped cues, each cut short: enough to recognize them. */
const SAMPLES_MAX = 3;
const SAMPLE_GRAPHEMES = 60;

/** The count of dropped cues of a file and a few of them as samples. */
export class DroppedCues {
  count = 0;
  readonly samples: string[] = [];

  add(sample: string): void {
    this.count += 1;
    if (this.samples.length >= SAMPLES_MAX) return;
    const clusters = graphemesOf(sample.trim());
    this.samples.push(clusters.length > SAMPLE_GRAPHEMES ? `${clusters.slice(0, SAMPLE_GRAPHEMES).join("")}…` : clusters.join(""));
  }

  toJSON(): { count: number; samples: string[] } {
    return { count: this.count, samples: [...this.samples] };
  }
}
