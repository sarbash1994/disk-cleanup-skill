#!/usr/bin/env node
import {EN} from './lib/strings.mjs';

const USAGE = 'Usage: node scan.mjs <strings|report|delete>';

const command = process.argv[2];

if (command === 'strings') {
  process.stdout.write(JSON.stringify(EN, null, 2) + '\n');
} else {
  process.stderr.write(USAGE + '\n');
  process.exit(2);
}
