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
    this.manager.setValue(name, Math.min(1, Math.max(0, value)));
  }

  update(blink: number, reaction: ReactionName | null, reactionWeight: number, mouthValue: number): void {
    if (!this.manager) return;
    for (const name of this.managedNames) this.manager.setValue(name, 0);

    const blinkName = this.resolve('blink');
    if (blinkName) {
      this.set('blink', blink);
    } else {
      this.set('blinkLeft', blink);
      this.set('blinkRight', blink);
    }

    if (reaction && reaction !== 'poke' && reaction !== 'sleepy' && reaction !== 'lookAround') this.set(reaction, reactionWeight);
    if (reaction === 'sleepy') this.set('sleepy', reactionWeight * 0.12);
    if (reaction === 'greet' || reaction === 'sleepy' || reaction === 'dance') this.set('aa', mouthValue * reactionWeight);
  }

  reset(): void {
    if (!this.manager) return;
    for (const name of this.managedNames) this.manager.setValue(name, 0);
    this.manager.update();
  }
}
