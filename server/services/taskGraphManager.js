// server/services/taskGraphManager.js


/**
 * Manages the execution state of a Task DAG.
 */
class TaskGraphManager {
    constructor(tasks = []) {
        this.tasks = tasks.map(t => ({
            ...t,
            status: t.status || 'pending',
            dependsOn: t.dependsOn || [],
            output: t.output || null,
            error: null,
            retryCount: 0
        }));
    }

    /**
     * Checks for circular dependencies in the task list.
     * @returns {boolean} True if circular dependency exists.
     */
    hasCircularDependencies() {
        const visited = new Set();
        const recStack = new Set();

        const isCyclic = (taskId) => {
            if (recStack.has(taskId)) return true;
            if (visited.has(taskId)) return false;

            visited.add(taskId);
            recStack.add(taskId);

            const task = this.tasks.find(t => t.id === taskId);
            if (task && task.dependsOn) {
                for (const depId of task.dependsOn) {
                    if (isCyclic(depId)) return true;
                }
            }

            recStack.delete(taskId);
            return false;
        };

        for (const task of this.tasks) {
            if (isCyclic(task.id)) return true;
        }
        return false;
    }

    /**
     * Gets tasks that are ready to be executed (dependencies met).
     * @returns {Array} List of executable tasks.
     */
    getExecutableTasks() {
        return this.tasks.filter(task => {
            if (task.status !== 'pending') return false;
            
            // All dependencies must be 'completed'
            return task.dependsOn.every(depId => {
                const depTask = this.tasks.find(t => t.id === depId);
                return depTask && depTask.status === 'completed';
            });
        });
    }

    /**
     * Mark a task as complete and store its result.
     * @param {string} taskId 
     * @param {any} output 
     */
    markTaskComplete(taskId, output) {
        const task = this.tasks.find(t => t.id === taskId);
        if (task) {
            task.status = 'completed';
            task.output = output;
            task.timestamp = Date.now();
        }
    }

    /**
     * Mark a task as failed.
     * @param {string} taskId 
     * @param {string} error 
     */
    markTaskFailed(taskId, error) {
        const task = this.tasks.find(t => t.id === taskId);
        if (task) {
            task.status = 'failed';
            task.error = error;
            
            // Mark all dependent tasks as 'skipped'
            this.markDependentsAsSkipped(taskId);
        }
    }

    markDependentsAsSkipped(failedTaskId) {
        const dependents = this.tasks.filter(t => t.dependsOn.includes(failedTaskId));
        for (const dep of dependents) {
            if (dep.status === 'pending') {
                dep.status = 'skipped';
                this.markDependentsAsSkipped(dep.id);
            }
        }
    }

    /**
     * Get all gathered context from completed dependencies of a task.
     * @param {string} taskId 
     * @returns {string} Combined output of parents.
     */
    getDependencyContext(taskId) {
        const task = this.tasks.find(t => t.id === taskId);
        if (!task) return "";

        return task.dependsOn
            .map(depId => {
                const dep = this.tasks.find(t => t.id === depId);
                return dep ? `[Result of ${dep.title}]:\n${dep.output}` : "";
            })
            .filter(Boolean)
            .join("\n\n");
    }

    isFinished() {
        return this.tasks.every(t => ['completed', 'failed', 'skipped'].includes(t.status));
    }

    /**
     * Converts a legacy flat steps array to a linear DAG.
     * @param {Array} steps 
     * @returns {Array} DAG-formatted tasks.
     */
    static convertFlatToDAG(steps) {
        return steps.map((step, index) => ({
            id: `task_${index}`,
            title: step.description,
            description: step.description,
            type: step.tool_call ? 'tool' : 'reasoning',
            tool_call: step.tool_call || null,
            dependsOn: index > 0 ? [`task_${index - 1}`] : [],
            status: 'pending'
        }));
    }
}

module.exports = TaskGraphManager;
