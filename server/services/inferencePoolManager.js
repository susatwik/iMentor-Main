/**
 * Inference Pool Manager
 * Implements Task 2.5.2: Inference pool management
 * Prevents dropping requests if multiple users query massive local SLMs simultaneously.
 */

class InferencePoolManager {
    constructor(maxConcurrent = 2) {
        this.maxConcurrent = maxConcurrent;
        this.activeRequests = 0;
        this.queue = [];
    }

    /**
     * Enqueues an inference request and resolves when a slot opens up
     */
    async acquireSlot() {
        if (this.activeRequests < this.maxConcurrent) {
            this.activeRequests++;
            return Promise.resolve();
        }

        return new Promise(resolve => {
            console.log(`[InferencePool] Hardware saturated. Queuing new SLM request...`);
            this.queue.push(resolve);
        });
    }

    /**
     * Releases an inference slot back to the pool
     */
    releaseSlot() {
        this.activeRequests--;
        if (this.queue.length > 0) {
            const nextRequest = this.queue.shift();
            this.activeRequests++;
            console.log(`[InferencePool] Slot freed. Dequeuing next SLM request.`);
            nextRequest();
        }
    }
}

const globalModelPool = new InferencePoolManager();

module.exports = {
    globalModelPool,
    InferencePoolManager
};
