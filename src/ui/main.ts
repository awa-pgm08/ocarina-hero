import { OcarinaEngine } from '../audio/engine';
import { LISTING, type DemoTrack, type SongData } from '../core/demo';
import { createTrackLoader, latestRequest, sourcesByFile } from '../core/track-loader';
import type { Arrangement, Note } from '../core/ir';
import {
  frequencyOf,
  pitchForButton,
  pitchById,
  type ControllerButton,
  type PitchSpec,
} from '../core/pitches';
import type { MelodyNote, Projection } from '../core/project';
import { prepareMelody } from '../core/prepare';
import { buttonLabel, noteInstruction, schemeBendLabel, toTabText, type ControlScheme } from '../core/tab';
import { buttonIcon, modifierIcon } from './controller-icons';
import { SourceImporter, type AudioSourceAnalysis, type PreparedAudio } from './import';
import { AudioFragmentEditor } from './audio-editor';
import { Controls } from './input';
import { GamepadInput } from './gamepad';
import { Playback } from './playback';
import { parseLocation, shareUrl, songDocumentTitle, songPath } from './route';
import { createPassages, advancePractice, comboTier, FreePlayTake, FREE_PLAY_TEMPO_BPM, lessonDetails, playbackSelection, resetPassage, scoreCombo, staffTransition, type Combo, type ComboMilestone } from './lesson';
import { centreIn, haptic, setPracticeFeedback, retrigger, ribbon, sparkBurst, stitchRipple } from './practice-fx';
import { swapStaff, timeNoteThread } from './staff-motion';
import { staffClef, staffTokenHtml } from './staff';
import { MiniPlayer } from './mini-player';
import { actionForCode, assignKey, BEND_ACTIONS, DEFAULT_BINDINGS, KEY_BINDINGS_STORAGE, KEYBOARD_ACTIONS, keyLabel, readBindings, handleKeyDown, type KeyboardAction } from './keyboard';
import { refreshThreadIcons, threadIcon, type ThreadIcon } from './thread-icons';
import { controlScheme, currentTheme, setTheme, syncStaticArt } from './theme';
import { SongbookView } from './songbook-view';
import { songMeta, type SongbookEntry } from './songbook';
import { nextSong } from './featured';
import { loadPopular, reportPlay } from './popularity';
import { bindPullToRefresh } from './pull-refresh';
import { completedIds, markOpened, markPractice, PROGRESS_STORAGE, readProgress, type Progress } from './progress';
import { DEFAULT_PREFERENCES, PREFERENCES_STORAGE, readPreferences, type PadStyle, type Preferences } from './preferences';
import { LOCAL_DATA_KEYS, parseSavedExport, savedExport } from './local-data';
import { displaySubtitle, displayTitle, getLang, initI18n, t } from './i18n';

const APP_BASE = import.meta.env.BASE_URL;
const engine = new OcarinaEngine();
let bindings = (() => {
  try { return readBindings(JSON.parse(localStorage.getItem(KEY_BINDINGS_STORAGE) ?? 'null')); }
  catch { return { ...DEFAULT_BINDINGS }; }
})();
let bindingTarget: KeyboardAction | null = null;
let progress = (() => {
  try { return readProgress(JSON.parse(localStorage.getItem(PROGRESS_STORAGE) ?? 'null')); }
  catch { return {}; }
})();
const desktop = window.matchMedia('(min-width: 800px)');
const recorded: Note[] = [];
const take = new FreePlayTake(recorded);
let bend = 0;
let songArrangement: Arrangement | null = null;

interface Source {
  readonly title: string;
  readonly subtitle: string;
  readonly tempoBpm: number;
  readonly beatsPerBar: number;
  readonly melody: readonly MelodyNote[];
  readonly fixedNotes?: readonly Note[];
  readonly preserveTiming?: boolean;
  readonly phraseStarts?: readonly number[];
  readonly analysis?: AudioSourceAnalysis;
}

let current: Source | null = null;

const pad = must<HTMLDivElement>('#pad');
const bends = must<HTMLDivElement>('#bend-pad');
const tab = must<HTMLDivElement>('#tab');
const hint = must<HTMLParagraphElement>('#hint');
const songHint = must<HTMLParagraphElement>('#song-hint');
const fileName = must<HTMLSpanElement>('#file-name');
const fileInput = must<HTMLInputElement>('#file');
const playbackRate = must<HTMLSelectElement>('#playback-rate');
const analysisDownload = must<HTMLButtonElement>('#analysis-download');
const bendsInput = must<HTMLInputElement>('#bends');
const simplifyInput = must<HTMLInputElement>('#simplify');
const playButton = must<HTMLButtonElement>('#play');
type AppView = 'catalog' | 'popular' | 'lesson' | 'workshop' | 'settings';
let view: AppView = 'catalog';
let selectedEntry: SongbookEntry | null = null;
let practiceMode = false;
let practiceCursor = 0;
let combo: Combo = { streak: 0, best: 0 };
let playbackCursor = 0;
let activeNote: number | null = null;
let passageIndex = 0;
let passages: number[][] = [];
let playbackIndices: number[] = [];
let playbackBeatMs = 625;
let renderedWindow: { song: unknown; indices: readonly number[] } | null = null;
let repeatingTimer: number | undefined;
let isPlaying = false;
const practiceStatus = must<HTMLParagraphElement>('#practice-status');
const comboBadge = must<HTMLParagraphElement>('#combo');
const practiceLine = must<HTMLDivElement>('.practice-line');
const statusSlot = must<HTMLDivElement>('.status-slot');
const tabText = must<HTMLParagraphElement>('#tab-text');
const progressTrack = must<HTMLDivElement>('.progress-track');
let comboHideTimer: number | undefined;
const songComplete = must<HTMLDivElement>('#song-complete');
const nextSongButton = must<HTMLButtonElement>('#next-song');
const passageSelect = must<HTMLSelectElement>('#passage');
const repeatPassage = must<HTMLInputElement>('#repeat-passage');
let selectedAudio: PreparedAudio | null = null;
let audioLoadVersion = 0;
const importer = new SourceImporter({
  onSource(source) {
    selectedEntry = null;
    practiceMode = false;
    fileName.textContent = source.title;
    renderSource(source);
    must<HTMLButtonElement>('#open-import').disabled = false;
    updateLessonHeading();
    showView('lesson');
    if (source.analysis) setWorkshopStatus(t('workshop.tabReady', { count: source.melody.length }));
  },
  onStatus(message) {
    songHint.textContent = message;
    setWorkshopStatus(message);
  },
  onPending(pending) {
    editor.setBusy(pending);
    showAnalysisProgress(pending);
    updateAnalyzeButton();
    playButton.disabled = pending || recorded.length === 0;
    analysisDownload.disabled = pending || !current?.analysis;
    simplifyInput.disabled = pending || current?.fixedNotes !== undefined || !!current?.preserveTiming;
    bendsInput.disabled = pending || current?.fixedNotes !== undefined;
    must<HTMLButtonElement>('#open-import').disabled = pending || current === null || selectedEntry !== null;
  },
});
const editor = new AudioFragmentEditor(must<HTMLElement>('#audio-editor'), {
  onSelectionChange() { invalidateAudioResult(t('workshop.fragmentChanged')); },
  onSelectionReady() { updateAnalyzeButton(); },
  onPreviewStart() {
    stopPlayback();
    controls.reset();
    clearActive();
  },
  onEditingFocus() {
    controls.reset();
    clearActive();
  },
});

const analyzeButton = must<HTMLButtonElement>('#analyze');
const analysisProgress = must<HTMLElement>('#analysis-progress');
const analysisElapsed = must<HTMLElement>('#analysis-elapsed');
let analysisPhase: 'decoding' | 'analysing' | 'importing' = 'analysing';
let analysisTimer: number | undefined;

function setWorkshopStatus(message: string): void {
  must('#workshop-status').textContent = message;
}

function updateAnalyzeButton(): void {
  analyzeButton.disabled = importer.pending || !selectedAudio || !editor.selection;
}

/** Show a determinate-looking but honest loader: a woven spinner plus elapsed time. */
function showAnalysisProgress(pending: boolean): void {
  window.clearInterval(analysisTimer);
  analysisTimer = undefined;
  analysisProgress.hidden = !pending;
  analyzeButton.hidden = pending;
  if (!pending) return;
  const seconds = editor.selection && selectedAudio ? (editor.selection.endIndex - editor.selection.startIndex) / selectedAudio.buffer.sampleRate : 0;
  must('#analysis-progress-label').textContent = analysisPhase === 'decoding'
    ? t('workshop.reading')
    : analysisPhase === 'importing' ? t('workshop.importingPhase') : t('workshop.findingPhase', { seconds: seconds.toFixed(1) });
  const started = performance.now();
  analysisElapsed.textContent = '0 s';
  analysisTimer = window.setInterval(() => { analysisElapsed.textContent = `${Math.floor((performance.now() - started) / 1000)} s`; }, 1000);
}

function invalidateAudioResult(message: string): void {
  importer.invalidate();
  stopPlayback();
  current = null;
  selectedEntry = null;
  songArrangement = null;
  recorded.length = 0;
  analysisDownload.disabled = true;
  renderTab();
  songHint.textContent = message;
  must('#workshop-status').textContent = message;
  must<HTMLButtonElement>('#open-import').disabled = true;
  updateAnalyzeButton();
}

function closeAudioEditor(): void {
  audioLoadVersion++;
  selectedAudio = null;
  importer.releaseAudio();
  editor.clear();
}

function must<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

function keyHtml(pitch: PitchSpec, extraClass = ''): string {
  return `
    <button class="key${extraClass ? ` ${extraClass}` : ''}" type="button" data-button="${pitch.button}"
      aria-label="${t('pad.playAria', { button: buttonLabel(pitch.button, controlScheme()), key: keyLabel(bindings[pitch.button]) })}"
      title="${t('pad.keyTitle', { pitch: pitch.id, key: keyLabel(bindings[pitch.button]) })}">
      ${buttonIcon(pitch.button)}
      <kbd class="key-ref">${keyLabel(bindings[pitch.button])}</kbd>
    </button>`;
}

function bendKeyHtml(value: number): string {
  return `
    <button class="bend-key" type="button" data-bend="${value}" aria-label="${schemeBendLabel(value, controlScheme())}" title="${schemeBendLabel(value, controlScheme())}">
      ${modifierIcon(value)}
      <kbd class="key-ref" data-bend-label="${value}">${keyLabel(bindings[KEYBOARD_ACTIONS.find(action => BEND_ACTIONS[action as keyof typeof BEND_ACTIONS] === value)!])}</kbd>
    </button>`;
}

/**
 * Pad presentation: the button list, or the embroidered gamepad. Mirrors the stored
 * preference; the Settings select further down writes both. Read straight from storage
 * here because the pad renders before that preferences block runs.
 */
let padStyle: PadStyle = (() => {
  try { return readPreferences(JSON.parse(localStorage.getItem(PREFERENCES_STORAGE) ?? 'null')).padStyle; }
  catch { return DEFAULT_PREFERENCES.padStyle; }
})();

/** Decorative gamepad cloth: navy body, gold stitched edge, grey sticks, a heart patch. Purely visual; the real buttons sit on top. */
function gamepadArt(): string {
  return `
    <svg class="gamepad-art" viewBox="0 0 360 210" aria-hidden="true" focusable="false">
      <rect x="36" y="8" width="64" height="28" rx="9" fill="#54648a" stroke="#93a5c9" stroke-width="1.4" stroke-dasharray="4 3" />
      <rect x="260" y="8" width="64" height="28" rx="9" fill="#54648a" stroke="#93a5c9" stroke-width="1.4" stroke-dasharray="4 3" />
      <path class="gp-body" d="M58 30 Q180 12 302 30 Q336 34 338 68 Q339 100 330 132 Q322 172 296 182 Q272 190 262 160 Q254 134 226 128 L134 128 Q106 134 98 160 Q88 190 64 182 Q38 172 30 132 Q21 100 22 68 Q24 34 58 30 Z" fill="#26314a" stroke="#c19845" stroke-width="5" />
      <path d="M58 30 Q180 12 302 30 Q336 34 338 68 Q339 100 330 132 Q322 172 296 182 Q272 190 262 160 Q254 134 226 128 L134 128 Q106 134 98 160 Q88 190 64 182 Q38 172 30 132 Q21 100 22 68 Q24 34 58 30 Z" transform="translate(180 105) scale(.93) translate(-180 -105)" fill="none" stroke="#d5ac55" stroke-width="1.6" stroke-dasharray="5 4" opacity=".75" />
      <circle cx="76" cy="82" r="27" fill="#1d2740" stroke="#8b98b0" stroke-width="1.4" stroke-dasharray="3 3" />
      <circle cx="176" cy="102" r="18" fill="#1d2740" stroke="#8b98b0" stroke-width="1.4" stroke-dasharray="3 3" />
      <circle cx="176" cy="102" r="12" fill="#39496a" />
      <circle cx="176" cy="102" r="6.5" fill="none" stroke="#8b98b0" stroke-width="1.4" />
      <circle cx="124" cy="54" r="7" fill="#d8c391" />
      <path d="M120.5 54 H127.5" stroke="#26314a" stroke-width="1.8" />
      <circle cx="222" cy="50" r="7" fill="#d8c391" />
      <path d="M218.5 50 H225.5 M222 46.5 V53.5" stroke="#26314a" stroke-width="1.8" />
      <path d="M0 5 C0 1 -3 -2 -7 -2 C-12 -2 -15 2 -15 6 C-15 12 -7 17 0 23 C7 17 15 12 15 6 C15 2 12 -2 7 -2 C3 -2 0 1 0 5 Z" transform="translate(166 56)" fill="#a83a2c" stroke="#e8cc8f" stroke-width="1.2" stroke-dasharray="3 2" />
    </svg>`;
}

function buildPad(): void {
  const retro = currentTheme() === 'retro';
  if (padStyle === 'controller') {
    pad.classList.add('pad--controller');
    pad.innerHTML = `
      <div class="gamepad">
        ${gamepadArt()}
        ${keyHtml(pitchForButton('L'), 'gp-shoulder gp-l')}
        ${retro ? '' : keyHtml(pitchForButton('R'), 'gp-shoulder gp-r')}
        <div class="gp-stick">
          ${bendKeyHtml(2)}
          ${bendKeyHtml(-2)}
        </div>
        <div class="gp-dpad">
          <span aria-hidden="true"></span>
          ${bendKeyHtml(1)}
          <span aria-hidden="true"></span>
          <span class="gp-arm" aria-hidden="true"></span>
          <span class="gp-arm gp-arm--center" aria-hidden="true"></span>
          <span class="gp-arm" aria-hidden="true"></span>
          <span aria-hidden="true"></span>
          ${bendKeyHtml(-1)}
          <span aria-hidden="true"></span>
        </div>
        <div class="gp-face">
          <span class="cell" aria-hidden="true"></span>
          ${keyHtml(pitchForButton('X'), 'gp-face-key')}
          <span class="cell" aria-hidden="true"></span>
          ${keyHtml(pitchForButton('Y'), 'gp-face-key')}
          ${retro ? keyHtml(pitchForButton('R'), 'gp-face-key') : '<span class="ghost" aria-hidden="true">B</span>'}
          ${keyHtml(pitchForButton('A'), 'gp-face-key')}
        </div>
      </div>`;
    bends.innerHTML = '';
    return;
  }
  pad.classList.remove('pad--controller');
  pad.innerHTML = `
    <div class="shoulders">
      ${keyHtml(pitchForButton('L'))}
      ${retro ? '' : keyHtml(pitchForButton('R'))}
    </div>
    <div class="diamond">
      <span class="cell" aria-hidden="true"></span>
      ${keyHtml(pitchForButton('X'))}
      <span class="cell" aria-hidden="true"></span>
      ${keyHtml(pitchForButton('Y'))}
      ${retro ? keyHtml(pitchForButton('R')) : '<span class="ghost" aria-hidden="true">B</span>'}
      ${keyHtml(pitchForButton('A'))}
    </div>`;
  bends.innerHTML = [1, -1, 2, -2].map(bendKeyHtml).join('');
}

function setActive(button: ControllerButton, active: boolean): void {
  pad.querySelector(`[data-button="${button}"]`)?.classList.toggle('is-active', active);
}

function clearActive(): void {
  for (const element of pad.querySelectorAll('.key.is-active')) {
    element.classList.remove('is-active');
  }
}

let lastNoteLabel = '';
let hintStarted = false;

function updateHint(): void {
  hintStarted = true;
  const parts: string[] = [];
  if (lastNoteLabel) parts.push(lastNoteLabel);
  parts.push(bend ? t('pad.bend', { label: schemeBendLabel(bend, controlScheme()) }) : t('pad.noBend'));
  hint.textContent = parts.join(' · ');
}

function press(pitch: PitchSpec): void {
  editor.stopPreview();
  if (isPlaying || repeatingTimer !== undefined) stopPlayback();
  engine.noteOn(pitch, bend);
  lastNoteLabel = `${buttonLabel(pitch.button, controlScheme())} · ${pitch.id} · ${frequencyOf(pitch.id, bend).toFixed(1)} Hz`;
  updateHint();

  if (songArrangement) {
    if (practiceMode && !isPlaying) practiceNote(pitch.button);
    return;
  }

  take.press(pitch.id, bend, performance.now());
  passageIndex = Number.MAX_SAFE_INTEGER; // renderTab clamps to the passage holding the newest note
  renderTab();
}

function renderTab(): void {
  playButton.disabled = importer.pending || recorded.length === 0;
  passages = createPassages(recorded, current?.tempoBpm ?? FREE_PLAY_TEMPO_BPM, current?.phraseStarts);
  tabText.textContent = current ? toTabText(recorded, undefined, current.tempoBpm, { scheme: controlScheme(), noteSeparator: ', ' }) : '';
  bends.hidden = current !== null && !recorded.some(note => !!note.bend);
  pad.classList.toggle('is-bends-hidden', bends.hidden);
  passageIndex = Math.max(0, Math.min(passageIndex, passages.length - 1));
  // Keep the staff and its passage controls at a stable size: free play can add a bend at any time.
  tab.classList.toggle('has-modifiers', current === null || recorded.some(note => !!note.bend));
  passageSelect.disabled = passages.length === 0;
  if (recorded.length === 0) {
    delete tab.dataset.notes;
    renderedWindow = null;
    passageSelect.replaceChildren(new Option(t('passage.of', { index: 1, total: 1 }), '0'));
    must<HTMLButtonElement>('#previous-passage').disabled = true;
    must<HTMLButtonElement>('#next-passage').disabled = true;
    tab.innerHTML = `${staffClef()}<p class="empty">${t('staff.empty')}</p>`;
    updateProgress();
    return;
  }
  if (passageSelect.options.length !== passages.length || passageSelect.options[0]?.text !== t('passage.of', { index: 1, total: passages.length })) {
    passageSelect.replaceChildren(...passages.map((_, index) => new Option(t('passage.of', { index: index + 1, total: passages.length }), String(index))));
  }
  passageSelect.value = String(passageIndex);
  must<HTMLButtonElement>('#previous-passage').disabled = passageIndex === 0;
  must<HTMLButtonElement>('#next-passage').disabled = passageIndex === passages.length - 1;
  const indices = passages[passageIndex]!;
  const signature = indices.map(index => `${index}:${recorded[index]!.pitch}:${recorded[index]!.bend ?? 0}`).join('|');
  if (tab.dataset.notes !== signature) {
    const focused = tab.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.noteIndex : undefined;
    const nextWindow = { song: songArrangement, indices };
    swapStaff(tab, staffTransition(renderedWindow, nextWindow), () => { tab.innerHTML = staffClef() + indices.map((index, slot) => {
    const expected = practiceMode && !isPlaying && practiceCursor === index;
    const classes = [activeNote === index && 'is-playing', expected && 'is-expected', practiceMode && index < practiceCursor && 'is-played'].filter(Boolean).join(' ');
    return staffTokenHtml(recorded[index]!, index, slot, indices.length, classes, activeNote === index || expected);
    }).join(''); });
    renderedWindow = nextWindow;
    tab.dataset.notes = signature;
    if (focused !== undefined) {
      (tab.querySelector<HTMLButtonElement>(`[data-note-index="${focused}"]`) ?? tab.querySelector<HTMLButtonElement>('.tok'))?.focus({ preventScroll: true });
    }
  }
  for (const token of tab.querySelectorAll<HTMLElement>('[data-note-index]')) {
    const index = Number(token.dataset.noteIndex);
    const expected = practiceMode && !isPlaying && practiceCursor === index;
    token.classList.toggle('is-playing', activeNote === index);
    token.classList.toggle('is-expected', expected);
    token.classList.toggle('is-played', practiceMode && index < practiceCursor);
    token.classList.toggle('is-past', !practiceMode && activeNote !== null && index < activeNote);
    timeNoteThread(token, activeNote === index, (recorded[index]!.durationBeats || 1) * playbackBeatMs);
    if (activeNote === index || expected) token.setAttribute('aria-current', 'true');
    else token.removeAttribute('aria-current');
  }
  updateProgress();
}

function arrangementLabel(projection: Projection): string {
  const percent = Math.round(projection.confidence * 100);
  const shift = projection.transpositionSemitones;
  return t('arrangement.fit', { percent, shift: `${shift > 0 ? '+' : ''}${shift}`, moved: projection.shiftedNotes, total: projection.notes.length, bent: projection.bentNotes });
}

function show(arrangement: Arrangement, label: string, play = false): void {
  songArrangement = arrangement;
  songComplete.hidden = true;
  practiceCursor = 0;
  combo = { streak: 0, best: 0 };
  playbackCursor = 0;
  passageIndex = 0;
  activeNote = null;
  recorded.length = 0;
  recorded.push(...arrangement.notes);
  renderTab();
  if (play) void replay();
  songHint.textContent = label;
  updateLessonHeading();
}

function renderSource(source: Source, play = false): void {
  if (importer.pending) return;
  stopPlayback();
  current = source;
  analysisDownload.disabled = !source.analysis;

  const fixed = source.fixedNotes !== undefined;
  simplifyInput.disabled = fixed || !!source.preserveTiming;
  simplifyInput.title = fixed ? t('arrangement.fixedTitle') : source.preserveTiming ? t('arrangement.audioTitle') : '';
  bendsInput.disabled = fixed;
  bendsInput.title = fixed ? t('arrangement.fixedTitle') : '';
  const prepared = prepareMelody(source, {
    simplify: simplifyInput.checked,
    maxBend: bendsInput.checked ? 2 : 0,
  });

  const removed = prepared.removed ? t('arrangement.ornamentsRemoved', { count: prepared.removed }) : '';
  const label = prepared.projection
    ? `${source.subtitle}${removed} · ${arrangementLabel(prepared.projection)}`
    : source.subtitle;

  show(
    { title: source.title, tempoBpm: source.tempoBpm, notes: prepared.notes },
    label,
    play,
  );
}

function runDemo(demo: DemoTrack): void {
  closeAudioEditor();
  fileName.textContent = displayTitle(demo);
  stopPlayback();
  renderSource({
    title: demo.title,
    subtitle: displaySubtitle(demo),
    tempoBpm: demo.tempoBpm,
    beatsPerBar: demo.beatsPerBar ?? 4,
    melody: demo.melody,
    fixedNotes: demo.fixedNotes,
    phraseStarts: demo.phraseStarts,
  });
}

initI18n();
buildPad();
renderTab();

function applyBend(value: number, glide = 0): void {
  bend = value;
  engine.setBend(value, glide);
  if (!songArrangement && take.bend(value, performance.now())) {
    passageIndex = Number.MAX_SAFE_INTEGER; // renderTab clamps to the passage holding the newest note
    renderTab();
  }

  for (const element of document.querySelectorAll<HTMLElement>('#pad .bend-key, #bend-pad .bend-key')) {
    element.classList.toggle('is-active', Number(element.dataset.bend) === value);
  }

  updateHint();
}

const controls = new Controls(
  (button) => {
    setActive(button, true);
    press(pitchForButton(button));
  },
  (button) => {
    setActive(button, false);
    engine.noteOff();
    if (!songArrangement) take.release(performance.now());
  },
  applyBend,
  (button) => setActive(button, false),
);

const gamepads = new GamepadInput(controls);
const gamepadStatus = must<HTMLParagraphElement>('#gamepad-status');
/** Whether the connected pad has a layout the app can read; null while none is connected. */
let gamepadReadable: boolean | null = null;
let gamepadFrame: number | undefined;

function renderGamepadStatus(): void {
  if (gamepadReadable === null) return;
  gamepadStatus.textContent = gamepadReadable ? t(controlScheme() === 'n64' ? 'gamepad.helpN64' : 'gamepad.helpSwitch') : t('gamepad.unrecognised');
}

/** Poll while the lesson is on screen and a usable pad is connected; one last empty poll releases what was held. */
function pollGamepads(): void {
  gamepadFrame = undefined;
  const playable = view === 'lesson' && !document.hidden;
  const connected = gamepads.update(playable ? navigator.getGamepads?.() ?? [] : [], controlScheme());
  if (playable && connected) gamepadFrame = requestAnimationFrame(pollGamepads);
}

function watchGamepads(): void {
  if (gamepadFrame === undefined) pollGamepads();
}

window.addEventListener('gamepadconnected', event => {
  gamepadReadable = event.gamepad.mapping === 'standard';
  renderGamepadStatus();
  watchGamepads();
});
window.addEventListener('gamepaddisconnected', () => {
  gamepadReadable = null;
  gamepadStatus.textContent = t('gamepad.disconnected');
});

const touchCapable = 'ontouchstart' in window;

/** Mouse and pen bind per element, so this re-runs after every pad re-render (theme, language, pad style). */
function bindPadPointer(): void {
  if (touchCapable) return;
  for (const element of document.querySelectorAll<HTMLElement>('#pad .key, #pad .bend-key, #bend-pad .bend-key')) {
    element.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const source = `pointer:${event.pointerId}`;
      if (element.dataset.bend !== undefined) {
        controls.bendDown(source, Number(element.dataset.bend));
      } else if (element.dataset.button) {
        controls.noteDown(source, element.dataset.button as ControllerButton);
      }
    });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      element.addEventListener(type, (event) => {
        const source = `pointer:${event.pointerId}`;
        controls.bendUp(source);
        controls.noteUp(source);
      });
    }
  }
}

if (touchCapable) {
  const hit = (x: number, y: number): HTMLElement | null => {
    const element = document.elementFromPoint(x, y);
    return element instanceof Element
      ? element.closest<HTMLElement>('[data-bend], [data-button]')
      : null;
  };
  document.addEventListener('touchstart', (event) => {
    for (const touch of Array.from(event.changedTouches)) {
      const element = hit(touch.clientX, touch.clientY);
      if (!element) continue;
      event.preventDefault();
      const source = `touch:${touch.identifier}`;
      if (element.dataset.bend !== undefined) {
        controls.bendDown(source, Number(element.dataset.bend));
      } else if (element.dataset.button) {
        controls.noteDown(source, element.dataset.button as ControllerButton);
      }
    }
  }, { passive: false });
  const releaseTouch = (event: TouchEvent): void => {
    for (const touch of Array.from(event.changedTouches)) {
      const source = `touch:${touch.identifier}`;
      controls.bendUp(source);
      controls.noteUp(source);
    }
  };
  document.addEventListener('touchend', releaseTouch);
  document.addEventListener('touchcancel', releaseTouch);
} else {
  bindPadPointer();
}


for (const container of [pad, bends]) {
  container.addEventListener('contextmenu', (event) => event.preventDefault());
}

function isEditingTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('#audio-editor, #keyboard-settings, input, select, textarea, [contenteditable]') !== null;
}

function actionLabel(action: KeyboardAction): string {
  if (!(action in BEND_ACTIONS)) return t('keyboard.buttonAction', { label: buttonLabel(action as ControllerButton, controlScheme()) });
  return schemeBendLabel(BEND_ACTIONS[action as keyof typeof BEND_ACTIONS], controlScheme());
}

function renderBindings(): void {
  const list = must('#keyboard-bindings');
  if (!list.childElementCount) list.innerHTML = KEYBOARD_ACTIONS.map(action =>
    `<div class="binding-row"><span class="binding-control">${action in BEND_ACTIONS ? modifierIcon(BEND_ACTIONS[action as keyof typeof BEND_ACTIONS]) : buttonIcon(action as ControllerButton)}<span>${actionLabel(action)}</span></span><button class="action binding-key" type="button" data-binding="${action}" aria-label="${t('keyboard.changeKeyAria', { label: actionLabel(action) })}"><kbd></kbd></button></div>`).join('');
  for (const button of list.querySelectorAll<HTMLButtonElement>('[data-binding]')) {
    const action = button.dataset.binding as KeyboardAction;
    button.querySelector('kbd')!.textContent = bindingTarget === action ? '…' : keyLabel(bindings[action]);
    button.setAttribute('aria-pressed', String(bindingTarget === action));
  }
  for (const key of pad.querySelectorAll<HTMLElement>('[data-button]')) {
    const button = key.dataset.button as ControllerButton;
    key.querySelector('kbd')!.textContent = keyLabel(bindings[button]);
    key.setAttribute('aria-label', t('pad.playAria', { button: buttonLabel(button, controlScheme()), key: keyLabel(bindings[button]) }));
    key.title = t('pad.keyTitle', { pitch: pitchForButton(button).id, key: keyLabel(bindings[button]) });
  }
  for (const label of document.querySelectorAll<HTMLElement>('#pad [data-bend-label], #bend-pad [data-bend-label]')) {
    const action = KEYBOARD_ACTIONS.find(action => BEND_ACTIONS[action as keyof typeof BEND_ACTIONS] === Number(label.dataset.bendLabel))!;
    label.textContent = keyLabel(bindings[action]);
  }
}

function saveBindings(): void {
  try {
    localStorage.setItem(KEY_BINDINGS_STORAGE, JSON.stringify(bindings));
    must('#keyboard-status').textContent = t('keyboard.saved');
  } catch { must('#keyboard-status').textContent = t('keyboard.sessionOnly'); }
}

function cancelBinding(): void {
  if (!bindingTarget) return;
  bindingTarget = null;
  renderBindings();
  must('#keyboard-status').textContent = t('keyboard.cancelled');
}

must('#keyboard-bindings').addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLElement>('[data-binding]');
  if (!button || !desktop.matches) return;
  stopPlayback();
  controls.reset();
  clearActive();
  bindingTarget = button.dataset.binding as KeyboardAction;
  renderBindings();
  must('#keyboard-status').textContent = t('keyboard.pressKey', { label: actionLabel(bindingTarget) });
});
must<HTMLDetailsElement>('#keyboard-settings').addEventListener('toggle', event => {
  if (!(event.target as HTMLDetailsElement).open) cancelBinding();
});
must('#reset-bindings').addEventListener('click', () => {
  controls.reset();
  clearActive();
  bindingTarget = null;
  bindings = { ...DEFAULT_BINDINGS };
  saveBindings();
  renderBindings();
});
document.addEventListener('pointerdown', event => {
  if (!(event.target as Element).closest('#keyboard-settings')) cancelBinding();
});
desktop.addEventListener('change', () => { cancelBinding(); controls.reset(); clearActive(); });
renderBindings();

window.addEventListener('focusin', (event) => {
  if (!isEditingTarget(event.target)) return;
  controls.reset();
  clearActive();
});

window.addEventListener('keydown', (event) => {
  if (bindingTarget && desktop.matches) {
    if (event.code === 'Escape' || event.code === 'Tab') {
      if (event.code === 'Escape') event.preventDefault();
      cancelBinding();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (event.repeat) return;
    const updated = assignKey(bindings, bindingTarget, event.code);
    if (!updated) {
      must('#keyboard-status').textContent = t('keyboard.chooseKey');
      return;
    }
    bindings = updated;
    bindingTarget = null;
    saveBindings();
    renderBindings();
    return;
  }
  if (view !== 'lesson' || isEditingTarget(event.target)) return;
  handleKeyDown(event, controls, bindings);
});

window.addEventListener('keyup', (event) => {
  if (isEditingTarget(event.target)) return;
  const action = actionForCode(bindings, event.code);
  if (action && action in BEND_ACTIONS) {
    event.preventDefault();
    controls.bendUp(`key:${event.code}`);
  } else if (action) {
    controls.noteUp(`key:${event.code}`);
  }
});

window.addEventListener('blur', () => {
  cancelBinding();
  controls.reset();
  clearActive();
});

must<HTMLButtonElement>('#clear').addEventListener('click', () => {
  closeAudioEditor();
  fileInput.value = '';
  fileName.textContent = t('workshop.noFileLoaded');
  analysisDownload.disabled = true;
  for (const input of [simplifyInput, bendsInput]) {
    input.disabled = false;
    input.title = '';
  }
  controls.reset();
  clearActive();
  stopPlayback();
  recorded.length = 0;
  current = null;
  selectedEntry = null;
  practiceMode = false;
  practiceCursor = 0;
  playbackCursor = 0;
  songArrangement = null;
  renderTab();
  updateLessonHeading();
  showView('lesson');
  practiceStatus.textContent = t('status.startMelody');
  songHint.textContent = t('status.freePlayRecording');
});

bendsInput.addEventListener('change', () => {
  savePreferences({ ...preferences, bends: bendsInput.checked });
  if (current) renderSource(current);
});

simplifyInput.addEventListener('change', () => {
  savePreferences({ ...preferences, simplify: simplifyInput.checked });
  if (current) renderSource(current);
});

function highlight(index: number | null): void {
  const next = index === null ? null : playbackIndices[index] ?? null;
  if (next === activeNote) return;
  activeNote = next;
  if (activeNote !== null) {
    playbackCursor = activeNote + 1;
    const nextPassage = passages.findIndex(indices => indices.includes(activeNote!));
    if (nextPassage >= 0) passageIndex = nextPassage;
  }
  renderTab();
}

const playback = new Playback(engine, {
  highlight,
  status: (playing) => {
    isPlaying = playing;
    setPlayLabel(playing ? 'Stop' : 'Play');
  },
  complete: () => {
    if (repeatPassage.checked && view === 'lesson' && current) {
      setPlayLabel('Stop');
      playbackCursor = passages[passageIndex]?.[0] ?? 0;
      practiceCursor = playbackCursor;
      repeatingTimer = window.setTimeout(() => { repeatingTimer = undefined; void replay(); }, 200);
    }
  },
  error: (error) => { practiceStatus.textContent = t('error.playback', { message: error instanceof Error ? error.message : 'unknown error' }); },
});

function stopPlayback(): void {
  window.clearTimeout(repeatingTimer);
  repeatingTimer = undefined;
  playback.stop();
}

function setPlayLabel(label: string): void {
  playButton.querySelector('.stitched-label')!.textContent = t(label === 'Stop' ? 'lesson.stop' : 'lesson.play');
  playButton.querySelector('.play-icon')!.innerHTML = threadIcon(label === 'Stop' ? 'stop' : 'play');
}

function replay(): void {
  editor.stopPreview();
  controls.reset();
  clearActive();
  const arrangement = songArrangement ?? (recorded.length ? { title: 'live', tempoBpm: FREE_PLAY_TEMPO_BPM, notes: recorded } : null);
  if (!arrangement) { stopPlayback(); return; }
  const cursor = practiceMode ? practiceCursor : playbackCursor;
  const selection = playbackSelection(arrangement, passages[passageIndex] ?? [], cursor, !!current && repeatPassage.checked);
  playbackIndices = selection.indices;
  if (!playbackIndices.length) return;
  playbackBeatMs = 60000 / (selection.arrangement.tempoBpm * Number(playbackRate.value));
  void playback.start(selection.arrangement, Number(playbackRate.value));
}

playButton.addEventListener('click', () => {
  if (playback.playing || repeatingTimer !== undefined) stopPlayback();
  else replay();
});

playbackRate.addEventListener('change', () => {
  savePreferences({ ...preferences, rate: readPreferences({ rate: playbackRate.value }).rate });
  const speed = playbackRate.selectedOptions[0]?.text ?? playbackRate.value;
  if (playback.playing) {
    replay();
    practiceStatus.textContent = t('speed.playingAt', { speed });
  } else {
    practiceStatus.textContent = t('speed.nextAt', { speed });
  }
});

async function openAudioFile(file: File): Promise<void> {
  const version = audioLoadVersion;
  songHint.textContent = t('workshop.reading');
  setWorkshopStatus('');
  analysisPhase = 'decoding';
  const audio = await importer.prepareAudio(file);
  if (!audio || version !== audioLoadVersion) return;
  selectedAudio = audio;
  try {
    await editor.setAudio(audio);
    if (version === audioLoadVersion) {
      const message = t('workshop.fragmentReady');
      songHint.textContent = message;
      setWorkshopStatus(message);
      updateAnalyzeButton();
    }
  } catch (error) {
    if (version !== audioLoadVersion) return;
    closeAudioEditor();
    songHint.textContent = t('workshop.editorFailed', { message: error instanceof Error ? error.message : 'unknown error' });
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  closeAudioEditor();
  invalidateAudioResult(t('workshop.preparing'));
  controls.reset();
  clearActive();
  fileName.textContent = file.name;
  if (/\.midi?$/i.test(file.name)) { analysisPhase = 'importing'; void importer.load(file); }
  else void openAudioFile(file);
  fileInput.value = '';
});

analyzeButton.addEventListener('click', () => {
  const selection = editor.selection;
  if (!selectedAudio || !selection || importer.pending) return;
  editor.stopPreview();
  invalidateAudioResult('');
  analysisPhase = 'analysing';
  void importer.analyzeAudio(selectedAudio, selection);
});

must('#cancel-analysis').addEventListener('click', () => {
  if (analysisPhase === 'analysing') {
    invalidateAudioResult(t('workshop.analysisCancelled'));
  } else {
    closeAudioEditor();
    fileName.textContent = t('workshop.noFileSelected');
    setWorkshopStatus(t('workshop.loadingCancelled'));
  }
  analyzeButton.focus();
});

function downloadJson(fileName: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

analysisDownload.addEventListener('click', () => {
  if (importer.pending || !current?.analysis) return;
  downloadJson(`${current.title.replace(/\.[^.]+$/, '')}-analysis.json`, JSON.stringify(current.analysis, null, 2));
});

function updateProgress(): void {
  const progress = must<HTMLProgressElement>('#progress');
  const position = Math.min(recorded.length, practiceMode ? practiceCursor : playbackCursor);
  progress.max = Math.max(1, recorded.length);
  progress.value = position;
  progressTrack.style.setProperty('--progress-ratio', String(position / Math.max(1, recorded.length)));
  must('#song-progress').hidden = current === null || recorded.length === 0;
  must('#progress-label').textContent = t('progress.notes', { done: position, total: recorded.length });
  must('#progress-percent').textContent = `${Math.round(position / Math.max(1, recorded.length) * 100)}%`;
  must('#progress-caption').textContent = t(practiceMode ? 'progress.practice' : 'progress.song');
  if (!practiceMode) renderCombo();
  const expected = practiceMode && !isPlaying ? recorded[practiceCursor] : undefined;
  for (const key of pad.querySelectorAll<HTMLElement>('[data-button]')) {
    key.classList.toggle('is-expected', !!expected && key.dataset.button === pitchById(expected.pitch).button);
  }
  for (const key of document.querySelectorAll<HTMLElement>('#pad [data-bend], #bend-pad [data-bend]')) {
    key.classList.toggle('is-expected', !!expected?.bend && Number(key.dataset.bend) === expected.bend);
  }
}

function renderLessonMeta(): void {
  const songProgress = selectedEntry ? progress[selectedEntry.id] : undefined;
  must('#lesson-meta').textContent = current
    ? [...lessonDetails(selectedEntry?.version, recorded.length, passages.length, getLang()), songProgress?.completed && t('common.completed'), songProgress && songProgress.bestCombo > 1 && t('lesson.bestCombo', { count: songProgress.bestCombo })].filter(Boolean).join(' · ')
    : t('lesson.makeMusic');
}

function updateLessonHeading(): void {
  must('#lesson-title').textContent = (selectedEntry ? displayTitle(selectedEntry) : current?.title) ?? t('nav.freeplay');
  const universe = must('#lesson-universe');
  universe.innerHTML = threadIcon(selectedEntry?.icon ?? 'music');
  universe.append(document.createTextNode(selectedEntry?.universe ?? (current ? t('lesson.yourMelody') : t('lesson.yourInstrument'))));
  renderLessonMeta();
  const save = must<HTMLButtonElement>('#save-song');
  const saved = !!selectedEntry && catalogue.isSaved(selectedEntry.id);
  save.hidden = selectedEntry === null;
  save.innerHTML = `${threadIcon(saved ? 'heart-filled' : 'heart-empty')}<span>${saved ? t('common.saved') : t('common.save')}</span>`;
  save.setAttribute('aria-pressed', String(saved));
  save.setAttribute('aria-label', saved ? t('lesson.removeSavedAria') : t('lesson.saveSongAria'));
  must('#share-song').hidden = selectedEntry === null;
  must('#song-modes').hidden = current === null;
  must('.app').classList.toggle('has-song', current !== null);
  must('#listen-mode').setAttribute('aria-pressed', String(!practiceMode));
  must('#practice-mode').setAttribute('aria-pressed', String(practiceMode));
  must<HTMLButtonElement>('#open-import').disabled = current === null || selectedEntry !== null || importer.pending;
  refreshPracticeStatus();
}

function refreshPracticeStatus(lead = ''): void {
  if (!current) {
    practiceStatus.textContent = recorded.length ? t('status.melodyReady') : t('status.startMelody');
  } else if (!practiceMode) {
    practiceStatus.textContent = t('status.listenFollow');
  } else {
    const expected = recorded[practiceCursor];
    practiceStatus.textContent = lead + (expected
      ? t('status.next', { instruction: noteInstruction(pitchById(expected.pitch).button, expected.bend ?? 0, controlScheme()) })
      : combo.best > 1 ? t('status.reachedEndCombo', { best: combo.best }) : t('status.reachedEndPlain'));
  }
}

/** One-shot motions of the combo slot; only one plays at a time. */
function moveCombo(motion: 'is-entering' | 'is-bumped' | 'is-raised' | 'is-broken'): void {
  comboBadge.classList.remove('is-entering', 'is-bumped', 'is-raised', 'is-broken');
  retrigger(comboBadge, motion);
}

/**
 * Show the running streak from the second hit: the slot is sewn in, each hit rolls the
 * count, a new tier stamps the slot and a broken streak drops away.
 */
function renderCombo(broken = false): void {
  window.clearTimeout(comboHideTimer);
  comboBadge.classList.remove('is-broken');
  if (broken && !comboBadge.hidden) {
    moveCombo('is-broken');
    comboHideTimer = window.setTimeout(() => { comboBadge.hidden = true; comboBadge.classList.remove('is-broken'); }, 500);
    return;
  }
  const visible = practiceMode && combo.streak >= 2;
  const count = comboBadge.querySelector('.combo-count')!;
  const entering = comboBadge.hidden;
  comboBadge.hidden = !visible;
  if (!visible) { count.textContent = ''; return; }
  if (count.textContent === `×${combo.streak}`) return;
  const tier = String(comboTier(combo.streak));
  const raised = !entering && comboBadge.dataset.tier !== tier;
  comboBadge.dataset.tier = tier;
  count.textContent = `×${combo.streak}`;
  retrigger(count, 'is-rolled');
  moveCombo(entering ? 'is-entering' : raised ? 'is-raised' : 'is-bumped');
  if (raised) stitchRipple(comboBadge);
}

function resetCombo(): void {
  combo = { streak: 0, best: combo.best };
  renderCombo();
}

/** Reward a correct note: sparks on the staff, a ripple on the pressed controls, ribbons at milestones. */
function rewardHit(point: { x: number; y: number } | null, button: ControllerButton, noteBend: number, milestone: ComboMilestone | null, cleared: boolean, finished: boolean): void {
  const tier = comboTier(combo.streak);
  if (point) sparkBurst(tab, point, tier);
  stitchRipple(pad.querySelector(`[data-button="${button}"]`));
  if (noteBend) stitchRipple(document.querySelector(`#pad [data-bend="${noteBend}"], #bend-pad [data-bend="${noteBend}"]`));
  retrigger(progressTrack, 'is-hit');
  if (cleared || finished) retrigger(progressTrack, 'is-swept');
  if (finished) {
    ribbon(practiceLine, t('ribbon.songComplete'), combo.best > 1 ? t('lesson.bestCombo', { count: combo.best }) : '', 'song');
    haptic([18, 50, 18, 50, 40]);
  } else if (milestone) {
    ribbon(statusSlot, `${t(`combo.${milestone.label}`)}!`, '', 'combo');
    haptic([14, 40, 22]);
  } else if (cleared) {
    ribbon(statusSlot, t('ribbon.passageClear'), '', 'passage');
    haptic([10, 30, 10]);
  } else {
    haptic(8);
  }
}

function saveProgress(next: Progress): void {
  progress = next;
  try { localStorage.setItem(PROGRESS_STORAGE, JSON.stringify(progress)); }
  catch { catalogue.noteSessionOnly(); }
}

function recordPractice(finished: boolean): void {
  if (!selectedEntry) return;
  const next = markPractice(progress, selectedEntry.id, { finished, bestCombo: combo.best });
  if (next === progress) return;
  saveProgress(next);
  renderLessonMeta();
}

/** After the last note, offer another run and the next song of the same collection. */
function offerNextStep(): void {
  const upcoming = selectedEntry && nextSong(catalogue.entries, selectedEntry.id, completedIds(progress));
  nextSongButton.hidden = !upcoming;
  if (upcoming) {
    nextSongButton.querySelector('.stitched-label')!.textContent = displayTitle(upcoming);
    nextSongButton.setAttribute('aria-label', t('lesson.nextSongAria', { title: displayTitle(upcoming) }));
    nextSongButton.dataset.song = upcoming.id;
  }
  songComplete.hidden = false;
}

function practiceNote(button: ControllerButton): void {
  const expected = recorded[practiceCursor];
  if (!expected) return;
  const next = advancePractice(recorded, practiceCursor, button, bend);
  const result = scoreCombo(combo, next !== practiceCursor);
  combo = result.combo;
  if (next === practiceCursor) {
    retrigger(pad.querySelector(`[data-button="${button}"]`), 'is-miss');
    if (result.broken) haptic(24);
    renderCombo(result.broken);
    practiceStatus.textContent = t(result.broken ? 'status.comboBroken' : 'status.keepPlace', { instruction: noteInstruction(pitchById(expected.pitch).button, expected.bend ?? 0, controlScheme()) });
    return;
  }
  const hitIndex = practiceCursor;
  const passage = passages[passageIndex]!;
  const cleared = next > passage[passage.length - 1]!;
  const finished = next >= recorded.length;
  practiceCursor = repeatPassage.checked && cleared ? passage[0]! : next;
  const nextPassage = passages.findIndex(indices => indices.includes(practiceCursor));
  if (nextPassage >= 0) passageIndex = nextPassage;
  renderTab();
  renderCombo();
  const stillDrawnHit = centreIn(tab, tab.querySelector(`[data-note-index="${hitIndex}"]`));
  const songFinished = finished && !repeatPassage.checked;
  rewardHit(stillDrawnHit, button, expected.bend ?? 0, result.milestone, cleared, songFinished);
  refreshPracticeStatus(result.milestone ? `${t(`combo.${result.milestone.label}`)}! ` : '');
  recordPractice(songFinished);
  if (songFinished) offerNextStep();
}

function selectPassage(index: number): void {
  const resume = playback.playing || repeatingTimer !== undefined;
  stopPlayback();
  controls.reset();
  clearActive();
  passageIndex = Math.max(0, Math.min(passages.length - 1, index));
  songComplete.hidden = true;
  practiceCursor = passages[passageIndex]?.[0] ?? 0;
  playbackCursor = practiceCursor;
  activeNote = null;
  resetCombo();
  renderTab();
  refreshPracticeStatus();
  if (resume) replay();
}

/** Songbook scroll position, kept while a lesson or the workshop is open so returning lands where the user left. */
let catalogScroll = 0;

/** The view the Settings gear returns to when it is pressed again. */
let settingsReturn: AppView = 'catalog';

function showView(next: AppView, pushHistory = true): void {
  songOpening.cancel();
  if (next === 'settings' && view !== 'settings') settingsReturn = view;
  cancelBinding();
  const scroller = must('#main-content');
  const returningToCatalog = view !== next && next === 'catalog';
  if (view === 'catalog' && next !== 'catalog') catalogScroll = scroller.scrollTop;
  if (next !== 'catalog' && next !== 'popular') miniPlayer.close();
  if (view !== next) {
    stopPlayback();
    controls.reset();
    clearActive();
    editor.stopPreview();
    if (view === 'workshop' && importer.pending) {
      audioLoadVersion++;
      importer.invalidate();
      setWorkshopStatus(t('workshop.analysisCancelledRetry'));
    }
  }
  view = next;
  must('.app').classList.toggle('is-lesson', next === 'lesson');
  for (const name of ['catalog', 'popular', 'lesson', 'workshop', 'settings'] as const) {
    must(`#${name}-view`).hidden = next !== name;
  }
  syncRoute(pushHistory);
  if (next === 'lesson') updateLessonHeading();
  if (next === 'lesson') watchGamepads();
  if (returningToCatalog) catalogue.refresh();
  if (next === 'catalog' || next === 'popular') refreshPopular();
  document.title = next !== 'lesson' || !current ? 'Ocarina Hero' : selectedEntry ? songDocumentTitle(displayTitle(selectedEntry), songMeta(selectedEntry)) : `${current.title} · Ocarina Hero`;
  scroller.scrollTop = returningToCatalog ? catalogScroll : 0;
}

/** Mark the current destination in the navigation and, optionally, record it in the history. */
function syncRoute(pushHistory: boolean): void {
  const route = view === 'lesson' && !current ? 'free' : view === 'catalog' && catalogue.showingSaved ? 'saved' : view;
  for (const link of document.querySelectorAll<HTMLElement>('.app-nav [data-view-link], .settings-link')) {
    if (link.dataset.viewLink === route || view === 'lesson' && current && link.dataset.viewLink === 'catalog') link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  const address = view === 'lesson' && selectedEntry ? songPath(APP_BASE, selectedEntry.id) : `${APP_BASE}#${route}`;
  if (pushHistory && location.pathname + location.hash !== address) history.pushState(null, '', address);
}

/** Notes of curated songs are separate files, fetched on demand and warmed when a song is likely to open. */
const trackLoader = createTrackLoader(LISTING, sourcesByFile(import.meta.glob<SongData>('../core/songs/catalogue/*.json', { import: 'default' })));
const songOpening = latestRequest();

/** Opens the lesson once the song's notes are in; a newer choice, or leaving the lesson, drops a slower earlier one. */
function openSong(entry: SongbookEntry, pushHistory = true): void {
  const latest = songOpening.begin();
  const begin = (track: DemoTrack): void => {
    if (!latest()) return;
    selectedEntry = entry;
    practiceMode = false;
    saveProgress(markOpened(progress, entry.id, Date.now()));
    reportPlay(entry.id, 'open');
    runDemo(track);
    showView('lesson', pushHistory);
  };
  const ready = trackLoader.cached(entry.id);
  if (ready) { begin(ready); return; }
  trackLoader.load(entry.id).then(begin, error => {
    if (latest()) console.error(`Could not load ${entry.title}`, error);
  });
}

const catalogue = new SongbookView(must('#catalog-view'), LISTING, {
  select: entry => openSong(entry),
  prefetch: entry => trackLoader.prefetch(entry.id),
  quickPlay: entry => {
    reportPlay(entry.id, 'quick-play');
    miniPlayer.toggle(entry);
  },
  savedChanged: updateLessonHeading,
  savedFilterChanged: () => { if (view === 'catalog') syncRoute(true); },
  progress: () => progress,
});

/** The shared ranking is fetched when the Songbook shows, at most once a minute. */
function refreshPopular(): void {
  void loadPopular().then(ids => catalogue.setPopular(ids));
}

let popularReload: Promise<void> | null = null;
/** Fetch the ranking now, past the once-a-minute cache: the pull gesture and the Refresh button share one request. */
function reloadPopular(): Promise<void> {
  popularReload ??= (async () => {
    const button = must<HTMLButtonElement>('#refresh-popular');
    const status = must('#popular-status');
    button.disabled = true;
    status.textContent = '';
    try {
      catalogue.setPopular(await loadPopular({ force: true }));
      status.textContent = t('popular.updated');
    } catch {
      status.textContent = t('popular.failed');
    } finally {
      button.disabled = false;
      popularReload = null;
    }
  })();
  return popularReload;
}

must('#refresh-popular').addEventListener('click', () => void reloadPopular());
bindPullToRefresh(must('#main-content'), must('#popular-pull'), { active: () => view === 'popular', refresh: reloadPopular });

const miniPlayer = new MiniPlayer(must('#mini-player'), engine, trackLoader, {
  open: entry => openSong(entry),
  changed: (id, playing) => catalogue.setNowPlaying(id, playing),
});

must('#save-song').addEventListener('click', () => {
  if (selectedEntry) catalogue.toggleSaved(selectedEntry.id);
});

let shareResetTimer: number | undefined;
must('#share-song').addEventListener('click', async () => {
  if (!selectedEntry) return;
  const button = must('#share-song .share-label');
  const url = shareUrl(location.href, APP_BASE, selectedEntry.id);
  const title = `${displayTitle(selectedEntry)} · Ocarina Hero`;
  let label = t('share.copied');
  try {
    if (navigator.share) { await navigator.share({ title, url }); return; }
    await navigator.clipboard.writeText(url);
  } catch (error) {
    if ((error as DOMException).name === 'AbortError') return;
    label = t('share.failed');
  }
  button.textContent = label;
  window.clearTimeout(shareResetTimer);
  shareResetTimer = window.setTimeout(() => { button.textContent = t('share.label'); }, 1800);
});

function switchLessonMode(practice: boolean): void {
  if (practiceMode === practice) return;
  stopPlayback();
  practiceMode = practice;
  selectPassage(0);
  updateLessonHeading();
}
must('#practice-mode').addEventListener('click', () => switchLessonMode(true));
must('#listen-mode').addEventListener('click', () => switchLessonMode(false));
must('#practice-again').addEventListener('click', () => selectPassage(0));
nextSongButton.addEventListener('click', () => {
  const entry = catalogue.entries.find(item => item.id === nextSongButton.dataset.song);
  if (entry) openSong(entry);
});
passageSelect.addEventListener('change', () => selectPassage(Number(passageSelect.value)));
must('#previous-passage').addEventListener('click', () => selectPassage(passageIndex - 1));
must('#next-passage').addEventListener('click', () => selectPassage(passageIndex + 1));
must('#restart').addEventListener('click', () => {
  // Free play has nothing to rewind to: reset discards the take.
  if (!songArrangement) {
    take.clear();
    selectPassage(0);
    return;
  }
  selectPassage(resetPassage(passageIndex, { practice: practiceMode, repeating: repeatPassage.checked }));
});
tab.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('[data-note-index]');
  if (!target) return;
  stopPlayback();
  songComplete.hidden = true;
  practiceCursor = Number(target.dataset.noteIndex);
  playbackCursor = practiceCursor;
  resetCombo();
  renderTab();
  refreshPracticeStatus();
});
repeatPassage.addEventListener('change', () => {
  if (playback.playing) replay();
  if (!repeatPassage.checked && repeatingTimer !== undefined) stopPlayback();
});
must('#open-import').addEventListener('click', () => showView('lesson'));

document.addEventListener('click', event => {
  const link = (event.target as Element).closest<HTMLElement>('[data-view-link], .brand');
  if (!link) return;
  event.preventDefault();
  const next = link.dataset.viewLink ?? 'catalog';
  if (next === 'free') openFreePlay();
  else if (next === 'saved') { catalogue.showSaved(true); showView('catalog'); }
  else if (next === 'settings' && view === 'settings') showView(settingsReturn);
  else if (['catalog', 'popular', 'lesson', 'workshop', 'settings'].includes(next)) {
    if (next === 'catalog' && link.closest('.app-nav')) catalogue.showSaved(false);
    showView(next as AppView);
  }
});

function openFreePlay(): void {
  if (current) must<HTMLButtonElement>('#clear').click();
  else { practiceMode = false; showView('lesson'); }
}

function restoreView(): void {
  const route = parseLocation(APP_BASE, location.pathname, location.hash);
  if (route.view === 'song') {
    const entry = catalogue.entries.find(item => item.id === route.songId);
    if (!entry) { history.replaceState(null, '', `${APP_BASE}#catalog`); showView('catalog', false); return; }
    if (entry === selectedEntry && current) showView('lesson', false);
    else openSong(entry, false);
    const address = songPath(APP_BASE, entry.id);
    if (location.pathname !== address || location.hash) history.replaceState(null, '', address + location.search);
    return;
  }
  if (location.pathname !== APP_BASE) history.replaceState(null, '', APP_BASE + location.search + location.hash);
  if (route.view === 'free') openFreePlay();
  else if (route.view === 'saved' || route.view === 'catalog') {
    catalogue.showSaved(route.view === 'saved');
    showView('catalog', false);
  } else showView(route.view, false);
}
window.addEventListener('popstate', restoreView);
window.addEventListener('visibilitychange', () => {
  if (document.hidden) { stopPlayback(); miniPlayer.pause(); controls.reset(); clearActive(); editor.stopPreview(); }
  else watchGamepads();
});
for (const icon of document.querySelectorAll<HTMLElement>('[data-thread-icon]')) {
  icon.innerHTML = threadIcon(icon.dataset.threadIcon as ThreadIcon);
}

const themePicker = must<HTMLFieldSetElement>('#theme-picker');
syncStaticArt();
function syncThemePicker(): void {
  for (const option of themePicker.querySelectorAll<HTMLInputElement>('input[name="theme"]')) option.checked = option.value === currentTheme();
}
syncThemePicker();
themePicker.addEventListener('change', event => setTheme((event.target as HTMLInputElement).value === 'retro' ? 'retro' : 'tapestry'));
document.addEventListener('themechange', () => {
  syncThemePicker();
  refreshThreadIcons();
  buildPad();
  bindPadPointer();
  must('#keyboard-bindings').replaceChildren();
  renderBindings();
  delete tab.dataset.notes;
  renderedWindow = null;
  renderTab();
  updateProgress();
  applyBend(bend);
  updateHint();
  refreshPracticeStatus();
  renderGamepadStatus();
  miniPlayer.refreshTheme();
});

const preferenceStatus = must<HTMLParagraphElement>('#preferences-status');
const preferenceInputs = {
  bends: must<HTMLInputElement>('#pref-bends'),
  simplify: must<HTMLInputElement>('#pref-simplify'),
  rate: must<HTMLSelectElement>('#pref-rate'),
  effects: must<HTMLInputElement>('#pref-effects'),
  haptics: must<HTMLInputElement>('#pref-haptics'),
  padStyle: must<HTMLSelectElement>('#pref-pad-style'),
};
let preferences: Preferences = (() => {
  try { return readPreferences(JSON.parse(localStorage.getItem(PREFERENCES_STORAGE) ?? 'null')); }
  catch { return DEFAULT_PREFERENCES; }
})();

function showPreferences(): void {
  bendsInput.checked = preferenceInputs.bends.checked = preferences.bends;
  simplifyInput.checked = preferenceInputs.simplify.checked = preferences.simplify;
  playbackRate.value = preferenceInputs.rate.value = preferences.rate;
  preferenceInputs.effects.checked = preferences.effects;
  preferenceInputs.haptics.checked = preferences.haptics;
  preferenceInputs.padStyle.value = preferences.padStyle;
  setPracticeFeedback(preferences);
}

function savePreferences(next: Preferences): void {
  preferences = next;
  showPreferences();
  try { localStorage.setItem(PREFERENCES_STORAGE, JSON.stringify(preferences)); }
  catch { preferenceStatus.textContent = t('prefs.sessionOnly'); }
}

showPreferences();
preferenceInputs.haptics.closest('label')!.hidden = !('vibrate' in navigator);
for (const [preference, lessonInput] of [[preferenceInputs.bends, bendsInput], [preferenceInputs.simplify, simplifyInput], [preferenceInputs.rate, playbackRate]] as const) {
  preference.addEventListener('change', () => {
    if (preference instanceof HTMLInputElement) (lessonInput as HTMLInputElement).checked = preference.checked;
    else lessonInput.value = preference.value;
    lessonInput.dispatchEvent(new Event('change'));
  });
}
preferenceInputs.effects.addEventListener('change', () => savePreferences({ ...preferences, effects: preferenceInputs.effects.checked }));
preferenceInputs.haptics.addEventListener('change', () => savePreferences({ ...preferences, haptics: preferenceInputs.haptics.checked }));
preferenceInputs.padStyle.addEventListener('change', () => {
  padStyle = preferenceInputs.padStyle.value === 'controller' ? 'controller' : 'list';
  savePreferences({ ...preferences, padStyle });
  buildPad();
  bindPadPointer();
  applyBend(bend);
  updateProgress();
});

const dataStatus = must<HTMLParagraphElement>('#data-status');
must('#export-saved').addEventListener('click', () => {
  const ids = catalogue.savedIds();
  if (!ids.length) { dataStatus.textContent = t('data.noneToExport'); return; }
  downloadJson('ocarina-hero-saved-songs.json', savedExport(ids));
  dataStatus.textContent = t(ids.length === 1 ? 'data.exportedOne' : 'data.exportedMany', { count: ids.length });
});
must<HTMLInputElement>('#import-saved').addEventListener('change', async event => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const ids = parseSavedExport(await file.text(), new Set(catalogue.entries.map(entry => entry.id)));
    const added = catalogue.importSaved(ids);
    dataStatus.textContent = added ? t(added === 1 ? 'data.addedOne' : 'data.addedMany', { count: added }) : t('data.alreadySaved');
  } catch {
    dataStatus.textContent = t('data.notExport');
  }
});
must('#clear-data').addEventListener('click', () => {
  if (!window.confirm(t('data.confirmClear'))) return;
  try { for (const key of LOCAL_DATA_KEYS) localStorage.removeItem(key); }
  catch { dataStatus.textContent = t('data.nothingToClear'); return; }
  location.reload();
});

window.addEventListener('languagechange', () => {
  catalogue.refreshLanguage();
  buildPad();
  bindPadPointer();
  must('#keyboard-bindings').replaceChildren();
  renderBindings();
  delete tab.dataset.notes;
  renderedWindow = null;
  renderTab();
  updateLessonHeading();
  document.title = view !== 'lesson' || !current ? 'Ocarina Hero' : selectedEntry ? songDocumentTitle(displayTitle(selectedEntry), songMeta(selectedEntry)) : `${current.title} · Ocarina Hero`;
  if (!songComplete.hidden) offerNextStep();
  updateProgress();
  refreshPracticeStatus();
  setPlayLabel(playback.playing || repeatingTimer !== undefined ? 'Stop' : 'Play');
  if (hintStarted) updateHint();
  else hint.textContent = t('lesson.pressNote');
  miniPlayer.refreshLanguage();
});

restoreView();
