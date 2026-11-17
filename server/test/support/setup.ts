// Loaded before every test file (jest.setupFilesAfterEnv).
import { afterEach } from '@jest/globals';
import { assertNoResponseViolations } from './app';

afterEach(assertNoResponseViolations);
