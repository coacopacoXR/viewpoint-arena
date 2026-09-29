import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// findBy*/waitFor give up after 1s by default, which the full suite's load can
// exceed for a lazily loaded chunk or a chain of mocked reads (see
// vitest.config.ts). A passing wait returns as soon as it passes, so this costs
// nothing when the machine is idle.
configure({ asyncUtilTimeout: 5_000 });
