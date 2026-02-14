import { describe, it, expect } from 'vitest';
import {
  isValidTransition,
  transitionState,
  createInitialState,
  isTerminalState,
  shouldLoopBack,
  getNextPhase,
} from './state-machine.js';
import { BuildPhase } from '../types/index.js';

describe('State Machine', () => {
  describe('isValidTransition', () => {
    it('allows pending → discovering', () => {
      expect(isValidTransition(BuildPhase.PENDING, BuildPhase.DISCOVERING)).toBe(true);
    });

    it('allows discovering → generating', () => {
      expect(isValidTransition(BuildPhase.DISCOVERING, BuildPhase.GENERATING)).toBe(true);
    });

    it('allows testing → generating (loop back)', () => {
      expect(isValidTransition(BuildPhase.TESTING, BuildPhase.GENERATING)).toBe(true);
    });

    it('disallows completed → any', () => {
      expect(isValidTransition(BuildPhase.COMPLETED, BuildPhase.PENDING)).toBe(false);
      expect(isValidTransition(BuildPhase.COMPLETED, BuildPhase.GENERATING)).toBe(false);
    });

    it('disallows failed → any', () => {
      expect(isValidTransition(BuildPhase.FAILED, BuildPhase.PENDING)).toBe(false);
    });

    it('disallows skipping phases', () => {
      expect(isValidTransition(BuildPhase.PENDING, BuildPhase.TESTING)).toBe(false);
    });
  });

  describe('createInitialState', () => {
    it('creates state with correct initial values', () => {
      const state = createInitialState('test-tool');

      expect(state.toolName).toBe('test-tool');
      expect(state.phase).toBe(BuildPhase.PENDING);
      expect(state.id).toBeDefined();
      expect(state.startedAt).toBeInstanceOf(Date);
      expect(state.discovery?.endpoints).toBe(0);
      expect(state.testing?.iterations).toBe(0);
    });

    it('generates unique IDs', () => {
      const state1 = createInitialState('tool1');
      const state2 = createInitialState('tool2');

      expect(state1.id).not.toBe(state2.id);
    });
  });

  describe('transitionState', () => {
    it('updates phase correctly', () => {
      const state = createInitialState('test-tool');
      const newState = transitionState(state, BuildPhase.DISCOVERING);

      expect(newState.phase).toBe(BuildPhase.DISCOVERING);
      expect(newState.toolName).toBe('test-tool');
    });

    it('throws on invalid transition', () => {
      const state = createInitialState('test-tool');

      expect(() => transitionState(state, BuildPhase.COMPLETED)).toThrow();
    });

    it('sets completedAt for terminal states', () => {
      const state = createInitialState('test-tool');
      const discovering = transitionState(state, BuildPhase.DISCOVERING);
      const failed = transitionState(discovering, BuildPhase.FAILED);

      expect(failed.completedAt).toBeInstanceOf(Date);
    });

    it('preserves existing data', () => {
      const state = createInitialState('test-tool');
      state.discovery = { endpoints: 100, specFiles: [], authMethods: [], gaps: [] };

      const newState = transitionState(state, BuildPhase.DISCOVERING);

      expect(newState.discovery?.endpoints).toBe(100);
    });
  });

  describe('isTerminalState', () => {
    it('returns true for completed', () => {
      const state = { ...createInitialState('test'), phase: BuildPhase.COMPLETED };
      expect(isTerminalState(state)).toBe(true);
    });

    it('returns true for failed', () => {
      const state = { ...createInitialState('test'), phase: BuildPhase.FAILED };
      expect(isTerminalState(state)).toBe(true);
    });

    it('returns false for active phases', () => {
      const state = { ...createInitialState('test'), phase: BuildPhase.TESTING };
      expect(isTerminalState(state)).toBe(false);
    });
  });

  describe('shouldLoopBack', () => {
    it('loops back when tests fail', () => {
      const state = {
        ...createInitialState('test'),
        phase: BuildPhase.TESTING,
        testing: { totalTests: 10, passed: 7, failed: 3, coverage: 80, iterations: 1 },
      };

      const result = shouldLoopBack(state);

      expect(result.shouldLoop).toBe(true);
      expect(result.targetPhase).toBe(BuildPhase.GENERATING);
    });

    it('does not loop after max iterations', () => {
      const state = {
        ...createInitialState('test'),
        phase: BuildPhase.TESTING,
        testing: { totalTests: 10, passed: 7, failed: 3, coverage: 80, iterations: 5 },
      };

      const result = shouldLoopBack(state);

      expect(result.shouldLoop).toBe(false);
    });

    it('loops back when coverage too low', () => {
      const state = {
        ...createInitialState('test'),
        phase: BuildPhase.TESTING,
        testing: { totalTests: 10, passed: 10, failed: 0, coverage: 50, iterations: 1 },
      };

      const result = shouldLoopBack(state);

      expect(result.shouldLoop).toBe(true);
      expect(result.reason).toContain('Coverage');
    });

    it('loops back on security issues', () => {
      const state = {
        ...createInitialState('test'),
        phase: BuildPhase.SECURITY_SCAN,
        security: { sastIssues: 0, criticalCves: 2, secretsDetected: 0, passed: false },
      };

      const result = shouldLoopBack(state);

      expect(result.shouldLoop).toBe(true);
      expect(result.targetPhase).toBe(BuildPhase.GENERATING);
    });
  });

  describe('getNextPhase', () => {
    it('returns discovering from pending', () => {
      const state = createInitialState('test');
      expect(getNextPhase(state)).toBe(BuildPhase.DISCOVERING);
    });

    it('returns null for completed state', () => {
      const state = { ...createInitialState('test'), phase: BuildPhase.COMPLETED };
      expect(getNextPhase(state)).toBe(null);
    });

    it('respects loop back logic', () => {
      const state = {
        ...createInitialState('test'),
        phase: BuildPhase.TESTING,
        testing: { totalTests: 10, passed: 7, failed: 3, coverage: 80, iterations: 1 },
      };

      // Should loop back to generating due to failed tests
      expect(getNextPhase(state)).toBe(BuildPhase.GENERATING);
    });
  });
});
