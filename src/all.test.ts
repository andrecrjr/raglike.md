/**
 * Consolidated Entry Point for all tests.
 * This file allows running the entire suite in a single worker if needed,
 * although bun test's default parallel behavior is now safe thanks to
 * per-file PGlite memory isolation.
 */

import "./engine.test";
import "./chunking.test";
import "./semantic.test";
import "./scope.test";
