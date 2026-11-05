// Excerpt of rainmana/cursorify at 464d61f74e76, src/index.ts, seen in P5.
import process from 'node:process';
import { Command } from 'commander';
import pc from 'picocolors';
import { rulesGenerate } from './rulesGenerate.js';
    if (options.listProviders) {
      console.log(pc.bold('\n📋 Available LLM Providers:\n'));
      const providers = registry.getProviderInfo();
      
      providers.forEach(provider => {
        console.log(pc.cyan(`${provider.displayName} (${provider.name}):`));
        console.log(`  Default Model: ${pc.green(provider.defaultModel)}`);
        console.log(`  Requires API Key: ${provider.requiresApiKey ? pc.red('Yes') : pc.green('No')}`);
        console.log(`  Available Models: ${provider.availableModels.slice(0, 5).join(', ')}${provider.availableModels.length > 5 ? '...' : ''}`);
        console.log('');
