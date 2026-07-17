// Test file for Restricted Streaming in Tree-of-Thought Synthesis
// Location: server/test/restrictedStreaming.test.js

const assert = require('assert');
const { createBufferedStreamingManager, createUnrestrictedStreamingManager, createStreamingManager } = require('../services/restrictedStreamingService');

/**
 * Test Suite: Restricted Streaming Feature
 * 
 * Purpose: Verify that the restricted streaming feature correctly buffers
 * intermediate ToT steps and only streams final synthesis tokens.
 */

describe('Restricted Streaming Service', () => {
  
  describe('createBufferedStreamingManager', () => {
    it('should buffer step_update callbacks', () => {
      const manager = createBufferedStreamingManager();
      
      manager.streamCallback({ type: 'step_update', content: { stepId: 'planning', title: 'Planning' } });
      manager.streamCallback({ type: 'step_update', content: { stepId: 'execution', title: 'Execution' } });
      
      const buffered = manager.getBufferedSteps();
      assert.strictEqual(buffered.length, 2);
      assert.strictEqual(buffered[0].content.stepId, 'planning');
      assert.strictEqual(buffered[1].content.stepId, 'execution');
    });

    it('should flush buffered steps to callback', () => {
      const manager = createBufferedStreamingManager();
      const emitted = [];
      
      manager.streamCallback({ type: 'step_update', content: { stepId: 'planning' } });
      manager.streamCallback({ type: 'step_update', content: { stepId: 'execution' } });
      
      manager.flushBufferedSteps((update) => {
        emitted.push(update);
      });
      
      assert.strictEqual(emitted.length, 2);
      assert.strictEqual(emitted[0].content.stepId, 'planning');
    });

    it('should not flush twice', () => {
      const manager = createBufferedStreamingManager();
      const emitted = [];
      
      manager.streamCallback({ type: 'step_update', content: { stepId: 'planning' } });
      manager.flushBufferedSteps((update) => { emitted.push(update); });
      manager.flushBufferedSteps((update) => { emitted.push(update); });
      
      assert.strictEqual(emitted.length, 1, 'Should only emit once');
    });

    it('should reset and clear buffers', () => {
      const manager = createBufferedStreamingManager();
      
      manager.streamCallback({ type: 'step_update', content: { stepId: 'planning' } });
      manager.reset();
      
      const buffered = manager.getBufferedSteps();
      assert.strictEqual(buffered.length, 0);
    });
  });

  describe('createUnrestrictedStreamingManager', () => {
    it('should not buffer anything', () => {
      const manager = createUnrestrictedStreamingManager();
      
      manager.streamCallback({ type: 'step_update', content: { stepId: 'planning' } });
      manager.streamCallback({ type: 'step_update', content: { stepId: 'execution' } });
      
      const buffered = manager.getBufferedSteps();
      assert.strictEqual(buffered.length, 0);
    });

    it('should have no-op flush', () => {
      const manager = createUnrestrictedStreamingManager();
      const emitted = [];
      
      manager.flushBufferedSteps((update) => {
        emitted.push(update);
      });
      
      assert.strictEqual(emitted.length, 0);
    });
  });

  describe('createStreamingManager', () => {
    it('should create buffered manager when isRestricted=true', () => {
      const manager = createStreamingManager(true);
      
      manager.streamCallback({ type: 'step_update', content: { stepId: 'planning' } });
      const buffered = manager.getBufferedSteps();
      
      assert.strictEqual(buffered.length, 1);
    });

    it('should create unrestricted manager when isRestricted=false', () => {
      const manager = createStreamingManager(false);
      
      manager.streamCallback({ type: 'step_update', content: { stepId: 'planning' } });
      const buffered = manager.getBufferedSteps();
      
      assert.strictEqual(buffered.length, 0);
    });
  });
});

/**
 * Integration Test Scenario: Restricted Streaming in processQueryWithToT_Streaming
 * 
 * When RESTRICT_TOT_STREAMING feature flag is enabled:
 * 1. All 9 ToT steps (complexity_check → confidence_calibration) buffer their events
 * 2. No step_update or status_update callbacks reach the client until synthesis
 * 3. At synthesis phase, all buffered steps are flushed to client
 * 4. Token streaming from LLM synthesis flows directly to client
 * 5. Final confidence_calibration step updates stream after synthesis
 * 
 * When RESTRICT_TOT_STREAMING feature flag is disabled:
 * 1. All steps stream immediately as before (backward compatible)
 */

/**
 * Environment Configuration:
 * 
 * Enable restricted streaming via:
 * 1. Environment variable:    RESTRICT_TOT_STREAMING=true
 * 2. Runtime override:         debugFeatureFlagsService.setFeatureFlag('RESTRICT_TOT_STREAMING', true)
 * 3. Direct check:             getFeatureFlagsSnapshot().RESTRICT_TOT_STREAMING
 */

/**
 * Streaming Sequence with RESTRICT_TOT_STREAMING=true:
 * 
 * [Client Receives]
 * Client <-- [synthesis: status_update] "Integrating insights into final explanation…"
 * Client <-- [buffered steps flushed]
 *   ├── complexity_check: completed
 *   ├── planning: completed
 *   ├── evaluation: completed
 *   ├── execution: completed
 *   ├── modeling: completed
 *   ├── scenario_simulation: completed
 *   ├── self_critique: completed
 *   └── synthesis: processing
 * Client <-- [token] "Core drivers that"
 * Client <-- [token] " explain this"
 * Client <-- [token] " phenomenon..."
 * ... (LLM tokens continue)
 * Client <-- [synthesis: completed]
 * Client <-- [confidence_calibration: completed]
 */

/**
 * Streaming Sequence with RESTRICT_TOT_STREAMING=false (default):
 * 
 * [Client Receives - Backward Compatible]
 * Client <-- [complexity_check: status + processing]
 * Client <-- [complexity_check: completed]
 * Client <-- [planning: status + processing]
 * Client <-- [planning: completed + options]
 * Client <-- [evaluation: status + processing]
 * ... (all steps stream as before)
 * Client <-- [synthesis: status + processing]
 * Client <-- [token] "Core drivers that"
 * ... (tokens continue)
 */

module.exports = { /* exported for integration testing */ };
