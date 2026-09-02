import type {
  AppSettings,
  BootstrapData,
  CharacterImportResult,
  CommandMessage,
  InstalledCharacter,
  RuntimeDiagnostics,
  RuntimePerformanceStats,
  FocusStatus,
  PetInteraction,
  PetStatus,
} from './types';

declare global {
  interface Window {
    yachiyoDesk: {
      getBootstrap(): Promise<BootstrapData>;
      updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
      setClickThrough(ignore: boolean): void;
      beginWindowDrag(screenX: number, screenY: number): void;
      updateWindowDrag(screenX: number, screenY: number): void;
      endWindowDrag(screenX: number, screenY: number): void;
      noteUserActivity(): void;
      setInteractionPanelOpen(open: boolean): void;
      showContextMenu(point?: { x: number; y: number }): void;
      resetWindow(): Promise<{ x: number; y: number; width: number; height: number } | null>;
      openDataFolder(): Promise<string>;
      createDesktopShortcut(): Promise<{ ok: boolean; path?: string; error?: string }>;
      getFocusStatus(): Promise<FocusStatus>;
      startFocus(mode: 'focus' | 'break', minutes: number): Promise<FocusStatus>;
      stopFocus(): Promise<FocusStatus>;
      getPetStatus(): Promise<PetStatus>;
      petInteract(action: PetInteraction): Promise<PetStatus>;
      listCharacters(): Promise<InstalledCharacter[]>;
      importCharacter(): Promise<CharacterImportResult>;
      importPmxCharacter(): Promise<CharacterImportResult>;
      switchCharacter(id: string): Promise<{ ok: boolean; error?: string }>;
      removeCharacter(id: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
      runtimeReady(details: RuntimeDiagnostics): void;
      runtimeTelemetry(details: RuntimePerformanceStats): void;
      runtimeError(details: { message: string; stack?: string }): void;
      onCommand(callback: (message: CommandMessage) => void): () => void;
      onSettingsChanged(callback: (settings: AppSettings) => void): () => void;
      onFocusChanged(callback: (status: FocusStatus) => void): () => void;
      onPetStatusChanged(callback: (status: PetStatus) => void): () => void;
    };
  }
}

export {};
