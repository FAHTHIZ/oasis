import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyInlineScript } from '../src/inline-code-readonly.mjs';
import { analyzeCommand, parseRule, ruleMatches } from '../src/permissions.mjs';
import { describeToolResult } from '../src/terminal-ui.mjs';

// The one-liner a free model wrote to answer "which region sold the most".
const CSV_SUMMARY = "const fs=require('fs');const data=fs.readFileSync('sales.csv','utf8').split('\\n').slice(1);const rev={};data.forEach(line=>{if(!line)return;const [date,region,product,units,price]=line.split(',');rev[region]=(rev[region]||0)+(+units*+price);});console.log(Object.entries(rev).sort((a,b)=>b[1]-a[1]).map(e=>`${e[0]}: ${e[1].toFixed(2)}`).join('\\n'));";

test('scripts that only read and print are not called high risk', () => {
  for (const [base, args] of [
    ['node', ['-e', CSV_SUMMARY]],
    ['node', ['-p', "require('fs').readFileSync('package.json','utf8')"]],
    ['node', ['-e', "const {readFileSync}=require('node:fs');process.stdout.write(JSON.parse(readFileSync('a.json','utf8')).name)"]],
    ['python3', ['-c', "import csv, collections\nd=collections.Counter()\nfor r in csv.DictReader(open('sales.csv')): d[r['region']]+=int(r['units'])*float(r['price'])\nprint(d.most_common())"]],
    ['python3', ['-c', "import json; print(json.load(open('a.json', 'r', encoding='utf-8'))['name'])"]]
  ]) {
    assert.equal(isReadOnlyInlineScript(base, args), true, base + ' ' + args[1].slice(0, 60));
    assert.equal(analyzeCommand(base, args).highRisk, undefined);
  }
});

test('scripts that write, run programs, reach the network or hide names stay high risk', () => {
  for (const [base, args] of [
    ['node', ['-e', 'process.exit(0)']],
    ['node', ['-e', "require('fs').writeFileSync('x','y')"]],
    ['node', ['-e', "const fs=require('fs');const k=Object.keys(fs)[9];fs[k]('x','y')"]],
    ['node', ['-e', "const fs=require('fs');Object.values(fs).find(f=>f.name.length===13)('x','y')"]],
    ['node', ['-e', "const f=require('fs');f['write'+'FileSync']('x','y')"]],
    ['node', ['-e', "const fs=require('fs');const g=fs;g.rmSync('x')"]],
    ['node', ['-e', "const {writeFileSync:w}=require('fs');w('x','y')"]],
    ['node', ['-e', "const m='child'+'_process';require(m)"]],
    ['node', ['-e', "fetch('http://example.com')"]],
    ['node', ['-e', 'console.log(process.env.HOME)']],
    ['node', ['-e', "console.log('\\x41')"]],
    ['node', ['-e', 'console.log(1)', '--inspect']],
    ['python3', ['-c', "import os; os.system('id')"]],
    ['python3', ['-c', "open('x','w').write('y')"]],
    ['python3', ['-c', "__import__('os').remove('x')"]],
    ['python3', ['-c', "getattr(__builtins__,'ev'+'al')('1')"]],
    ['python3', ['-c', '().__class__.__base__.__subclasses__()']],
    ['python3', ['-c', 'import csv as c, os']],
    ['python3', ['-c', "f=open;f('x','w')"]]
  ]) {
    assert.equal(isReadOnlyInlineScript(base, args), false, base + ' ' + args.join(' '));
    assert.match(analyzeCommand(base, args).highRisk || '', /runs inline code/);
  }
});

test('an allow rule that names only the program does not approve inline code', () => {
  const rule = parseRule('run_command(node:*)');
  assert.equal(ruleMatches(rule, 'run_command', { command: 'node', args: ['app.js'] }), true);
  assert.equal(ruleMatches(rule, 'run_command', { command: 'node', args: ['-e', "require('fs').writeFileSync('x','y')"] }), false);
  assert.equal(ruleMatches(parseRule('run_command(node -e:*)'), 'run_command', { command: 'node', args: ['-e', "require('fs').writeFileSync('x','y')"] }), true);
  assert.equal(ruleMatches(parseRule('run_command(python3:*)'), 'run_command', { command: 'python3', args: ['-c', "import os; os.system('id')"] }), false);
});

test('a short command result is shown whole, not just its last line', () => {
  const line = describeToolResult('run_command', { exitCode: 0, stdout: 'South: 9609.28\nEast: 9190.93\nNorth: 8926.88\nWest: 8286.53\n' }, { color: false });
  assert.match(line, /South: 9609\.28 · East/);
  assert.match(describeToolResult('run_command', { exitCode: 0, stdout: '1\n2\n3\n4\n5\nBuilt in 3s\n' }, { color: false }), /Built in 3s \(6 lines\)/);
});
