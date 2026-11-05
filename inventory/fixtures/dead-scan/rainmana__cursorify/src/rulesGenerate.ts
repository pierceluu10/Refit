// Excerpt of rainmana/cursorify at 464d61f74e76, src/rulesGenerate.ts, seen in P5.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import pc from 'picocolors';
import { generateWithLLM } from './llm-generator-v2.js';
