import type { CharacterProfile, NarratorProfile, VoiceSettings } from "@/lib/db/schema";
import type { VoiceProfile } from "@/lib/elevenlabs/catalog";
import type { ModelPrefs } from "@/lib/llm-models";

export interface BookData {
  id: string;
  title: string;
  author: string | null;
  status: string;
  povType: "first" | "third" | null;
  narratorProfile: NarratorProfile | null;
  renderModel: string;
  sfxEnabled: boolean;
  modelPrefs: ModelPrefs | null;
  pipelineStage: string | null;
  sourceFileName: string;
  introAudioPath: string | null;
  introDurationSec: number | null;
  introMusicPrompt: string | null;
  error: string | null;
}

export interface ChapterMeta {
  id: string;
  idx: number;
  title: string;
  charCount: number;
  status: string;
  durationSec: number | null;
  audioPath: string | null;
  error: string | null;
}

export interface AssignmentData {
  voiceId: string;
  voiceName: string;
  settings: VoiceSettings;
  rationale: string | null;
  overridden: boolean;
}

export interface CharacterData {
  id: string;
  name: string;
  aliases: string[];
  role: "narrator" | "major" | "minor";
  profile: CharacterProfile;
  quotes: string[];
  dialogueShare: number;
  isNarrator: boolean;
  variantGroup: string | null;
  variantLabel: string | null;
  profileEdited: boolean;
  assignment: AssignmentData | null;
}

export type VoiceData = VoiceProfile;

export interface JobData {
  id: string;
  type: "analyze" | "cast" | "script" | "generate" | "intro";
  chapterId: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  done: number;
  total: number;
  note: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProgressData {
  book: { id: string; status: string; pipelineStage: string | null; error: string | null };
  chapters: {
    id: string;
    idx: number;
    status: string;
    durationSec: number | null;
    audioPath: string | null;
    error: string | null;
  }[];
  jobs: JobData[];
}

export interface ApiKeysPresent {
  anthropic: boolean;
  eleven: boolean;
}
