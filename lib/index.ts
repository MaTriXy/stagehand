import { type Page, type BrowserContext, chromium } from '@playwright/test';
import { expect } from '@playwright/test';
import Cache from './cache';
import OpenAI from 'openai';
import crypto from 'crypto';
import Instructor, { type InstructorClient } from '@instructor-ai/instructor';
import { z } from 'zod';
import fs from 'fs';
import { act } from './inference';

require('dotenv').config({ path: '.env' });

async function getBrowser(env: 'LOCAL' | 'BROWSERBASE' = 'BROWSERBASE') {
  if (process.env.BROWSERBASE_API_KEY && env !== 'LOCAL') {
    console.log('Connecting you to broswerbase...');
    const browser = await chromium.connectOverCDP(
      `wss://api.browserbase.com?apiKey=${process.env.BROWSERBASE_API_KEY}`
    );
    const context = browser.contexts()[0];
    return { browser, context };
  } else {
    if (!process.env.BROWSERBASE_API_KEY) {
      console.log('No browserbase key detected');
      console.log('Starting a local browser...');
    }

    const tmpDir = fs.mkdtempSync(`/tmp/pwtest`);
    fs.mkdirSync(`${tmpDir}/userdir/Default`, { recursive: true });

    const defaultPreferences = {
      plugins: {
        always_open_pdf_externally: true,
      },
    };

    fs.writeFileSync(
      `${tmpDir}/userdir/Default/Preferences`,
      JSON.stringify(defaultPreferences)
    );

    const downloadsPath = `${process.cwd()}/downloads`;
    fs.mkdirSync(downloadsPath, { recursive: true });

    const context = await chromium.launchPersistentContext(
      `${tmpDir}/userdir`,
      {
        acceptDownloads: true,
        headless: false,
      }
    );

    console.log('Local browser started successfully.');
    return { context };
  }
}

export class Stagehand {
  private openai: OpenAI;
  private instructor: InstructorClient<OpenAI>;
  public observations: { [key: string]: { result: string; id: string } };
  private actions: { [key: string]: { result: string; id: string } };
  id: string;
  public page: Page;
  public context: BrowserContext;
  public env: 'LOCAL' | 'BROWSERBASE';
  public cache: Cache;
  public verbose: boolean;

  constructor(
    {
      env,
      disableCache,
      verbose = false,
    }: {
      env: 'LOCAL' | 'BROWSERBASE';
      disableCache?: boolean;
      verbose?: boolean;
    } = {
      env: 'BROWSERBASE',
      disableCache: false,
    }
  ) {
    this.openai = new OpenAI();
    this.instructor = Instructor({
      client: this.openai,
      mode: 'TOOLS',
    });
    this.env = env;
    this.cache = new Cache({ disabled: disableCache });
    this.observations = this.cache.readObservations();
    this.actions = this.cache.readActions();
    this.verbose = verbose;
  }

  log({ category, message }: { category?: string; message: string }) {
    if (this.verbose) {
      const categoryString = category ? `:${category}` : '';
      console.log(`[stagehand${categoryString}] ${message}`);
    }
  }
  async downloadPDF(url: string, title) {
    const downloadPromise = this.page.waitForEvent('download');
    await this.act({
      action: `click on ${url}`,
    });
    const download = await downloadPromise;
    await download.saveAs(`downloads/${title}.pdf`);
    await download.delete();
  }

  async init() {
    const { context } = await getBrowser(this.env);
    this.context = context;
    this.page = context.pages()[0];

    const utils = require('path').resolve(
      process.cwd(),
      'lib/dom/build/utils.js'
    );

    const processor = require('path').resolve(
      process.cwd(),
      'lib/dom/build/process.js'
    );
    await this.page.addInitScript({ path: utils });
    await this.page.addInitScript({ path: processor });
  }

  async waitForSettledDom() {
    try {
      await this.page.evaluate(() => window.waitForDomSettle());
    } catch (e) {
      console.log(e);
    }
  }

  getKey(operation) {
    return crypto.createHash('sha256').update(operation).digest('hex');
  }

  async extract<T extends z.AnyZodObject>({
    instruction,
    schema,
  }: {
    instruction: string;
    schema: T;
  }): Promise<z.infer<T>> {
    this.log({
      category: 'extraction',
      message: `starting extraction ${instruction}`,
    });
    await this.waitForSettledDom();

    const { outputString } = await this.page.evaluate(() =>
      window.processElements()
    );

    this.log({
      category: 'DOM',
      message: `available elements:\n${outputString}`,
    });

    // think about chunking
    const selectorResponse = await this.instructor.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: `instruction: ${instruction}
          DOM: ${outputString}`,
        },
      ],
      response_model: {
        schema: schema,
        name: 'Extraction',
      },
      temperature: 0.1,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });

    this.log({
      category: 'extraction',
      message: `response: ${JSON.stringify(selectorResponse)}`,
    });

    return selectorResponse;
  }

  async observe(observation: string): Promise<string | null> {
    const key = this.getKey(observation);
    const observationLocatorStr = this.observations[key]?.result;
    if (observationLocatorStr) {
      this.log({
        category: 'observation',
        message: `cache hit! using ${JSON.stringify(this.observations[key])}`,
      });

      // the locator string found by the LLM might resolve to multiple places in the DOM
      const firstLocator = await this.page
        .locator(observationLocatorStr)
        .first();

      await expect(firstLocator).toBeAttached();

      return key;
    }

    const { outputString, selectorMap } = await this.page.evaluate(() =>
      window.processElements()
    );

    this.log({
      category: 'DOM',
      message: `available elements:\n${outputString}`,
    });
    const selectorResponse = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are helping the user automate the browser by finding a playwright locator string. You will be given a instruction of the element to find, and a numbered list of possible elements.
            return only element id we are looking for
            if the element is not found, return NONE`,
        },
        {
          role: 'user',
          content: `
                    instruction: ${observation}
                    DOM: ${outputString}
                    `,
        },
      ],

      temperature: 0.1,
      top_p: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
    });

    const elementId = selectorResponse.choices[0].message.content;

    if (!elementId) {
      throw new Error('no response when finding a selector');
    }

    if (elementId === 'NONE') {
      this.log({
        category: 'observation',
        message: `no element found for ${observation}`,
      });
      return null;
    }

    this.log({
      category: 'observation',
      message: `found element ${elementId}`,
    });

    const locatorString = `xpath=${selectorMap[elementId]}`;

    this.log({
      category: 'observation',
      message: `found locator ${locatorString}`,
    });

    // the locator string found by the LLM might resolve to multiple places in the DOM
    const firstLocator = this.page.locator(locatorString).first();

    await expect(firstLocator).toBeAttached();
    const cachedKey = await this.cacheObservation(observation, locatorString);

    return cachedKey;
  }
  setId(key: string) {
    this.id = key;
  }

  async cacheObservation(observation: string, result: string): Promise<string> {
    const key = this.getKey(observation);

    this.observations[key] = { result, id: this.id };

    this.cache.writeObservations({ key, value: { result, id: this.id } });
    return key;
  }

  async cacheAction(action: string, result: string): Promise<string> {
    const key = this.getKey(action);

    this.actions[key] = { result, id: this.id };

    this.cache.writeActions({ key, value: { result, id: this.id } });
    return key;
  }

  async act({ action }: { action: string }): Promise<void> {
    await this.waitForSettledDom();

    this.log({
      category: 'Action',
      message: `taking action: ${action}`,
    });
    const key = this.getKey(action);
    let cachedAction = this.actions[key];
    if (cachedAction) {
      this.log({
        category: 'action',
        message: `cache hit for action: ${action}`,
      });
      const res = JSON.parse(cachedAction.result);
      const commands = res.length ? res : [res];

      for (const command of commands) {
        const locatorStr = command['locator'];
        const method = command['method'];
        const args = command['args'];

        this.log({
          category: 'action',
          message: `Cached action ${method} on ${locatorStr} with args ${args}`,
        });
        const locator = await this.page.locator(locatorStr).first();
        await locator[method](...args);
      }

      return;
    }

    const { outputString, selectorMap } = await this.page.evaluate(() =>
      window.processElements()
    );

    this.log({
      category: 'DOM',
      message: `available elements:\n${outputString}`,
    });

    const response = await act({
      action,
      domElements: outputString,
      client: this.openai,
    });
    this.log({
      category: 'action',
      message: `response: ${JSON.stringify(response)}`,
    });
    const commands = response.length ? response : [response];
    for (const command of commands) {
      const element = command['element'];
      const path = selectorMap[element];
      const method = command['method'];
      const args = command['args'];

      this.log({
        category: 'action',
        message: `taking action ${method} on ${path} with args ${args}`,
      });
      const locator = await this.page.locator(`xpath=${path}`).first();
      await locator[method](...args);
    }

    // disable cache for now
    // this.cacheAction(action, response.choices[0].message.content);

    await this.waitForSettledDom();
  }
  setPage(page: Page) {
    this.page = page;
  }
  setContext(context: BrowserContext) {
    this.context = context;
  }
}