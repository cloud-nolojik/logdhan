/**
 * Script to safely remove console.log statements from JavaScript files using Babel AST
 * This approach parses the code properly and only removes console.log calls without breaking code structure
 *
 * Usage:
 *   Single file:  node src/scripts/removeConsoleLogs.js <file_path>
 *   Folder:       node src/scripts/removeConsoleLogs.js <folder_path> --folder
 *   Dry run:      node src/scripts/removeConsoleLogs.js <path> --dry-run
 *
 * Examples:
 *   node src/scripts/removeConsoleLogs.js src/services/agendaMonitoringService.js
 *   node src/scripts/removeConsoleLogs.js src/services --folder
 *   node src/scripts/removeConsoleLogs.js src --folder --dry-run
 */

import fs from 'fs';
import path from 'path';
import * as parser from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';

// Handle both ESM default exports
const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

// Files/folders to skip
const SKIP_PATTERNS = [
    'node_modules',
    '.git',
    'dist',
    'build',
    '.next',
    'coverage',
    '__tests__',
    '*.test.js',
    '*.spec.js',
    'removeConsoleLogs.js' // Don't process this script itself
];

function shouldSkip(filePath) {
    const fileName = path.basename(filePath);
    const dirName = path.dirname(filePath);

    for (const pattern of SKIP_PATTERNS) {
        if (pattern.startsWith('*')) {
            const ext = pattern.slice(1);
            if (fileName.endsWith(ext)) return true;
        } else {
            if (fileName === pattern || dirName.includes(pattern)) return true;
        }
    }
    return false;
}

function removeConsoleLogs(filePath, dryRun = false) {
    if (shouldSkip(filePath)) {
        return null;
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const originalLength = content.length;
    let removedCount = 0;

    let ast;
    try {
        ast = parser.parse(content, {
            sourceType: 'module',
            plugins: [
                'jsx',
                'typescript',
                'classProperties',
                'classPrivateProperties',
                'classPrivateMethods',
                'dynamicImport',
                'optionalChaining',
                'nullishCoalescingOperator',
                'decorators-legacy',
                'exportDefaultFrom',
                'exportNamespaceFrom',
                'asyncGenerators',
                'functionBind',
                'functionSent',
                'numericSeparator',
                'objectRestSpread',
                'optionalCatchBinding',
                'throwExpressions',
                'topLevelAwait'
            ],
            allowImportExportEverywhere: true,
            allowAwaitOutsideFunction: true,
            allowReturnOutsideFunction: true,
            allowSuperOutsideMethod: true
        });
    } catch (parseError) {
        console.error(`  ✗ Parse error in ${filePath}: ${parseError.message}`);
        return { filePath, removedCount: 0, bytesSaved: 0, skipped: true, parseError: true };
    }

    // Track nodes to remove
    const nodesToRemove = new Set();

    traverse(ast, {
        CallExpression(path) {
            const callee = path.node.callee;

            // Check if it's console.log, console.error, console.warn, console.info, console.debug
            if (
                t.isMemberExpression(callee) &&
                t.isIdentifier(callee.object, { name: 'console' }) &&
                t.isIdentifier(callee.property) &&
                ['log', 'error', 'warn', 'info', 'debug'].includes(callee.property.name)
            ) {
                // Only remove console.log, keep console.error for error handling
                if (callee.property.name === 'log') {
                    // Find the statement containing this expression
                    let statementPath = path;
                    while (statementPath && !t.isStatement(statementPath.node)) {
                        statementPath = statementPath.parentPath;
                    }

                    if (statementPath && t.isExpressionStatement(statementPath.node)) {
                        nodesToRemove.add(statementPath);
                        removedCount++;
                    }
                }
            }
        }
    });

    // Remove the nodes
    for (const nodePath of nodesToRemove) {
        try {
            nodePath.remove();
        } catch (e) {
            // Node might already be removed or have issues
        }
    }

    // Generate the new code
    let newCode;
    try {
        const output = generate(ast, {
            retainLines: true,      // Keep line numbers similar
            retainFunctionParens: true,
            comments: true,         // Keep comments
            compact: false,
            concise: false
        }, content);
        newCode = output.code;
    } catch (genError) {
        console.error(`  ✗ Generate error in ${filePath}: ${genError.message}`);
        return { filePath, removedCount: 0, bytesSaved: 0, skipped: true, generateError: true };
    }

    // Clean up excessive empty lines (more than 2 consecutive)
    newCode = newCode.replace(/\n{3,}/g, '\n\n');

    const newLength = newCode.length;
    const bytesSaved = originalLength - newLength;

    if (removedCount === 0) {
        return { filePath, removedCount: 0, bytesSaved: 0, noChanges: true };
    }

    if (!dryRun) {
        fs.writeFileSync(filePath, newCode, 'utf8');
    }

    return { filePath, removedCount, bytesSaved, originalLength, newLength, dryRun };
}

function processFolder(folderPath, dryRun = false) {
    const results = [];
    let totalRemoved = 0;
    let totalBytesSaved = 0;
    let filesProcessed = 0;
    let filesSkipped = 0;
    let filesWithErrors = 0;

    function walkDir(dir) {
        const files = fs.readdirSync(dir);

        for (const file of files) {
            const filePath = path.join(dir, file);
            const stat = fs.statSync(filePath);

            if (shouldSkip(filePath)) {
                continue;
            }

            if (stat.isDirectory()) {
                walkDir(filePath);
            } else if (file.endsWith('.js') || file.endsWith('.mjs')) {
                try {
                    const result = removeConsoleLogs(filePath, dryRun);
                    if (result === null) {
                        filesSkipped++;
                    } else if (result.parseError || result.generateError) {
                        filesWithErrors++;
                    } else if (result.noChanges) {
                        // No console.logs found
                    } else {
                        results.push(result);
                        totalRemoved += result.removedCount;
                        totalBytesSaved += result.bytesSaved;
                        filesProcessed++;

                        if (result.removedCount > 0) {
                            const relativePath = path.relative(folderPath, filePath);
                            console.log(`  ✓ ${relativePath}: ${result.removedCount} removed, ${result.bytesSaved} bytes saved`);
                        }
                    }
                } catch (err) {
                    console.error(`  ✗ Error processing ${filePath}: ${err.message}`);
                    filesWithErrors++;
                }
            }
        }
    }

    console.log(`\n🧹 ${dryRun ? '[DRY RUN] ' : ''}Processing folder: ${folderPath}\n`);
    walkDir(folderPath);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 Summary${dryRun ? ' (DRY RUN - no changes made)' : ''}`);
    console.log(`${'='.repeat(60)}`);
    console.log(`   Files processed: ${filesProcessed}`);
    console.log(`   Files skipped: ${filesSkipped}`);
    console.log(`   Files with errors: ${filesWithErrors}`);
    console.log(`   Total console.logs removed: ${totalRemoved}`);
    console.log(`   Total bytes saved: ${totalBytesSaved} (${(totalBytesSaved / 1024).toFixed(2)} KB)`);
    console.log(`${'='.repeat(60)}\n`);

    return { results, totalRemoved, totalBytesSaved, filesProcessed, filesSkipped, filesWithErrors };
}

// Main execution
const args = process.argv.slice(2);

if (args.length === 0) {
    console.log(`
Usage:
  Single file:  node src/scripts/removeConsoleLogs.js <file_path>
  Folder:       node src/scripts/removeConsoleLogs.js <folder_path> --folder
  Dry run:      node src/scripts/removeConsoleLogs.js <path> --dry-run

Examples:
  node src/scripts/removeConsoleLogs.js src/services/agendaMonitoringService.js
  node src/scripts/removeConsoleLogs.js src/services --folder
  node src/scripts/removeConsoleLogs.js src --folder --dry-run
`);
    process.exit(1);
}

const targetPath = args[0];
const isFolder = args.includes('--folder');
const dryRun = args.includes('--dry-run');

const absolutePath = path.isAbsolute(targetPath) ? targetPath : path.join(process.cwd(), targetPath);

if (!fs.existsSync(absolutePath)) {
    console.error(`❌ Path not found: ${absolutePath}`);
    process.exit(1);
}

const stat = fs.statSync(absolutePath);

if (stat.isDirectory()) {
    if (!isFolder) {
        console.log(`\n⚠️  "${targetPath}" is a folder. Use --folder flag to process all files.`);
        console.log(`   Example: node src/scripts/removeConsoleLogs.js ${targetPath} --folder\n`);
        process.exit(1);
    }
    processFolder(absolutePath, dryRun);
} else {
    console.log(`\n🧹 ${dryRun ? '[DRY RUN] ' : ''}Removing console.log statements from: ${absolutePath}`);
    const result = removeConsoleLogs(absolutePath, dryRun);

    if (result) {
        if (result.parseError) {
            console.log(`\n❌ Could not parse file - skipped`);
        } else if (result.noChanges) {
            console.log(`\n✅ No console.log statements found`);
        } else {
            console.log(`\n✅ ${dryRun ? '[DRY RUN] Would clean' : 'Cleaned'}: ${result.filePath}`);
            console.log(`   ├─ Console.log statements removed: ${result.removedCount}`);
            console.log(`   ├─ Original size: ${result.originalLength} bytes`);
            console.log(`   ├─ New size: ${result.newLength} bytes`);
            console.log(`   └─ Bytes saved: ${result.bytesSaved} bytes (${((result.bytesSaved/result.originalLength)*100).toFixed(1)}%)\n`);
        }
    }
}
