import type { VRMExpressionManager } from '@pixiv/three-vrm';
import type { ReactionName } from './types';

const ALIASES: Record<string, string[]> = {
  blink: ['blink'],
  blinkLeft: ['blinkLeft', 'blink_l', 'blinkl'],
  blinkRight: ['blinkRight', 'blink_r', 'blinkr'],
  joy: ['happy', 'joy', 'fun', 'relaxed'],
  greet: ['happy', 'joy', 'fun', 'relaxed'],
  surprised: ['surprised', 'Surprised'],
  angry: ['angry'],
  sleepy: ['relaxed', 'fun', 'happy'],
  bow: ['relaxed', 'happy', 'joy'],
  stretch: ['relaxed', 'happy', 'joy'],
  dance: ['happy', 'joy', 'fun', 'relaxed'],
  lookAround: ['relaxed', 'neutral'],
  nod: ['relaxed', 'happy', 'neutral'],
  shakeHead: ['relaxed', 'neutral'],
  shy: ['sad', 'relaxed', 'happy'],
  cheer: ['happy', 'joy', 'fun', 'relaxed'],
  think: ['relaxed', 'neutral'],
  crouch: ['relaxed', 'neutral'],
  tiptoe: ['happy', 'relaxed', 'neutral'],
  sway: ['happy', 'joy', 'fun', 'relaxed'],
  aa: ['aa', 'a'],
};

export class ExpressionController {
  readonly names: string[];
  private readonly manager: VRMExpressionManager | undefined;
  private readonly nameByLowercase = new Map<string, string>();
  private readonly resolvedAliases = new Map<string, string | null>();
  private readonly managedNames = new Set<string>();
  private readonly emotionValues = new Map<string, number>();
  private transitionFrom = new Map<string, number>();
  private reaction: ReactionName | null = null;
  private transitionElapsed = 0.22;

  constructor(manager: VRMExpressionManager | undefined) {
    this.manager = manager;
    this.names = manager ? Object.keys(manager.expressionMap) : [];
    for (const name of this.names) this.nameByLowercase.set(name.toLowerCase(), name);
  }

  private resolve(alias: string): string | null {
    if (this.resolvedAliases.has(alias)) return this.resolvedAliases.get(alias) ?? null;
    const candidates = ALIASES[alias] ?? [alias];
    for (const candidate of candidates) {
      const exact = this.names.find((name) => name === candidate);
      if (exact) {
        this.resolvedAliases.set(alias, exact);
        return exact;
      }
      const insensitive = this.nameByLowercase.get(candidate.toLowerCase());
      if (insensitive) {
        this.resolvedAliases.set(alias, insensitive);
        return insensitive;
      }
    }
    this.resolvedAliases.set(alias, null);
    return null;
  }

  private set(alias: string, value: number): void {
    const name = this.resolve(alias);
    if (!name || !this.manager) return;
    this.managedNames.add(name);
    this.manager.setValue(name, Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
  }

  update(blink: number, reaction: ReactionName | null, reactionWeight: number, mouthValue: number, delta = 1 / 60): void {
    if (!this.manager) return;
    for (const name of this.managedNames) this.manager.setValue(name, 0);

    const blinkName = this.resolve('blink');
    if (blinkName) {
      this.set('blink', blink);
    } else {
      this.set('blinkLeft', blink);
      this.set('blinkRight', blink);
    }

    // Match AIRI's expression ownership and interrupted-emote transition:
    // capture the displayed emotion before a new reaction's envelope starts
    // at zero. Blink and mouth retain their own immediate control channels.
    if (reaction !== this.reaction) {
      this.transitionFrom = new Map(this.emotionValues);
      this.transitionElapsed = 0;
      this.reaction = reaction;
    }
    this.transitionElapsed += Number.isFinite(delta) ? Math.max(0, delta) : 0;
    const progress = Math.min(1, this.transitionElapsed / 0.22);
    const blend = progress * progress * (3 - 2 * progress);
    const name = reaction && reaction !== 'poke' && reaction !== 'lookAround' ? this.resolve(reaction) : null;
    const target = Number.isFinite(reactionWeight) ? Math.min(1, Math.max(0, reactionWeight)) * (reaction === 'sleepy' ? 0.12 : 1) : 0;
    if (name && !this.emotionValues.has(name)) this.emotionValues.set(name, 0);
    for (const [emotion] of this.emotionValues) {
      const value = (this.transitionFrom.get(emotion) ?? 0) * (1 - blend) + (emotion === name ? target : 0) * blend;
      this.emotionValues.set(emotion, value);
      this.managedNames.add(emotion);
      this.manager.setValue(emotion, value);
    }
    if (reaction === 'greet' || reaction === 'sleepy' || reaction === 'dance' || reaction === 'cheer') this.set('aa', mouthValue * reactionWeight);
  }

  reset(): void {
    if (!this.manager) return;
    for (const name of this.managedNames) this.manager.setValue(name, 0);
    this.emotionValues.clear(); this.transitionFrom.clear();
    this.reaction = null; this.transitionElapsed = 0.22;
    this.manager.update();
  }
}
