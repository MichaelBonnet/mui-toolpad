import * as path from 'path';
import * as fs from 'fs/promises';
import { isMainThread } from 'worker_threads';
import * as yaml from 'yaml';
import invariant from 'invariant';
import openEditor from 'open-editor';
import chalk from 'chalk';
import { BindableAttrValue, NodeId, PropBindableAttrValue } from '@mui/toolpad-core';
import { fromZodError } from 'zod-validation-error';
import { glob } from 'glob';
import * as chokidar from 'chokidar';
import { debounce, throttle } from 'lodash-es';
import { Emitter } from '@mui/toolpad-utils/events';
import { errorFrom } from '@mui/toolpad-utils/errors';
import { filterValues, hasOwnProperty, mapValues } from '@mui/toolpad-utils/collections';
import { execa } from 'execa';
import {
  writeFileRecursive,
  readMaybeFile,
  readMaybeDir,
  updateYamlFile,
  fileExists,
} from '@mui/toolpad-utils/fs';
import * as appDom from '../appDom';
import insecureHash from '../utils/insecureHash';
import {
  Page,
  Query,
  ElementType,
  pageSchema,
  Template,
  BindableProp,
  LocalQueryConfig,
  FetchQueryConfig,
  QueryConfig,
  FetchBody,
  ResponseType,
  Theme,
  themeSchema,
  API_VERSION,
} from './schema';
import { format } from '../utils/prettier';
import {
  Body as AppDomFetchBody,
  FetchQuery,
  ResponseType as AppDomRestResponseType,
} from '../toolpadDataSources/rest/types';
import { LocalQuery } from '../toolpadDataSources/local/types';
import { ProjectEvents, ToolpadProjectOptions } from '../types';
import { Awaitable } from '../utils/types';
import EnvManager from './EnvManager';
import FunctionsManager from './FunctionsManager';
import { VersionInfo, checkVersion } from './versionInfo';
import { VERSION_CHECK_INTERVAL } from '../constants';
import DataManager from './DataManager';
import type { RuntimeConfig } from '../config';

invariant(
  isMainThread,
  'localMode should be used only in the main thread. Use message passing to get data from the main thread.',
);

function getToolpadFolder(root: string): string {
  return path.join(root, './toolpad');
}

function getThemeFile(root: string): string {
  return path.join(getToolpadFolder(root), './theme.yml');
}

function getComponentsFolder(root: string): string {
  const toolpadFolder = getToolpadFolder(root);
  return path.join(toolpadFolder, './components');
}

function getPagesFolder(root: string): string {
  const toolpadFolder = getToolpadFolder(root);
  return path.join(toolpadFolder, './pages');
}

function getPageFolder(root: string, name: string): string {
  const pagesFolder = getPagesFolder(root);
  const pageFolder = path.resolve(pagesFolder, name);
  return pageFolder;
}

function getPageFile(root: string, name: string): string {
  const pageFolder = getPageFolder(root, name);
  const pageFileName = path.resolve(pageFolder, 'page.yml');
  return pageFileName;
}

function getComponentFilePath(componentsFolder: string, componentName: string): string {
  return path.join(componentsFolder, `${componentName}.tsx`);
}

export function getOutputFolder(root: string) {
  return path.join(getToolpadFolder(root), '.generated');
}

export function getAppOutputFolder(root: string) {
  return path.join(getOutputFolder(root), 'app');
}

export async function legacyConfigFileExists(root: string): Promise<boolean> {
  const [yamlFileExists, ymlFileExists] = await Promise.all([
    fileExists(path.join(root, './toolpad.yaml')),
    fileExists(path.join(root, './toolpad.yml')),
  ]);
  return yamlFileExists || ymlFileExists;
}

type ComponentsContent = Record<string, { code: string }>;

export interface ComponentEntry {
  name: string;
  path: string;
}

export async function getComponents(root: string): Promise<ComponentEntry[]> {
  const componentsFolder = getComponentsFolder(root);
  const entries = (await readMaybeDir(componentsFolder)) || [];
  const result = entries.map((entry) => {
    if (entry.isFile()) {
      const fileName = entry.name;
      const componentName = entry.name.replace(/\.tsx$/, '');
      const filePath = path.resolve(componentsFolder, fileName);
      return { name: componentName, path: filePath };
    }
    return null;
  });
  return result.filter(Boolean);
}

async function loadCodeComponentsFromFiles(root: string): Promise<ComponentsContent> {
  const components = await getComponents(root);
  const resultEntries = await Promise.all(
    components.map(async (component): Promise<[string, { code: string }]> => {
      const content = await fs.readFile(component.path, { encoding: 'utf-8' });
      return [component.name, { code: content }];
    }),
  );

  return Object.fromEntries(resultEntries);
}

async function loadPagesFromFiles(root: string): Promise<PagesContent> {
  const pagesFolder = getPagesFolder(root);
  const entries = (await readMaybeDir(pagesFolder)) || [];
  const resultEntries = await Promise.all(
    entries.map(async (entry): Promise<[string, Page] | null> => {
      if (entry.isDirectory()) {
        const pageName = entry.name;
        const filePath = path.resolve(pagesFolder, pageName, './page.yml');
        const content = await readMaybeFile(filePath);
        if (!content) {
          return null;
        }
        let parsedFile: Page | undefined;
        try {
          parsedFile = yaml.parse(content);
        } catch (rawError) {
          const error = errorFrom(rawError);

          console.error(
            `${chalk.red('error')} - Failed to read page ${chalk.cyan(pageName)}. ${error.message}`,
          );

          return null;
        }

        const result = pageSchema.safeParse(parsedFile);

        if (result.success) {
          return [pageName, result.data];
        }

        console.error(
          `${chalk.red('error')} - Failed to read page ${chalk.cyan(pageName)}. ${fromZodError(
            result.error,
          )}`,
        );

        return null;
      }

      return null;
    }),
  );

  return Object.fromEntries(resultEntries.filter(Boolean));
}

async function loadThemeFromFile(root: string): Promise<Theme | null> {
  const themeFilePath = getThemeFile(root);
  const content = await readMaybeFile(themeFilePath);
  if (content) {
    const parsedFile = yaml.parse(content);
    const result = themeSchema.safeParse(parsedFile);
    if (result.success) {
      return result.data;
    }

    console.error(
      `${chalk.red('error')} - Failed to read theme ${chalk.cyan(themeFilePath)}. ${fromZodError(
        result.error,
      )}`,
    );

    return null;
  }
  return null;
}

function createDefaultCodeComponent(name: string): string {
  const componentId = name.replace(/\s/g, '');
  const propTypeId = `${componentId}Props`;
  return format(`
    import * as React from 'react';
    import { Typography } from '@mui/material';
    import { createComponent } from '@mui/toolpad/browser';
    
    export interface ${propTypeId} {
      msg: string;
    }
    
    function ${componentId}({ msg }: ${propTypeId}) {
      return (
        <Typography>{msg}</Typography>
      );
    }

    export default createComponent(${componentId}, {
      argTypes: {
        msg: {
          type: "string",
          default: "Hello world!"
        },
      },
    });    
  `);
}

class Lock {
  pending: Promise<any> | null = null;

  async use<T = void>(doWork: () => Promise<T>): Promise<T> {
    try {
      this.pending = Promise.resolve(this.pending).then(() => doWork());
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }
}

const DEFAULT_GENERATED_GITIGNORE_FILE_CONTENT = `.generated
`;

async function initGitignore(root: string) {
  const projectFolder = getToolpadFolder(root);
  const generatedGitignorePath = path.resolve(projectFolder, '.gitignore');
  if (!(await fileExists(generatedGitignorePath))) {
    // eslint-disable-next-line no-console
    console.log(`${chalk.blue('info')}  - Initializing .gitignore file`);
    await writeFileRecursive(generatedGitignorePath, DEFAULT_GENERATED_GITIGNORE_FILE_CONTENT, {
      encoding: 'utf-8',
    });
  }
}

async function writeCodeComponentsToFiles(
  componentsFolder: string,
  components: ComponentsContent,
): Promise<void> {
  await Promise.all(
    Object.entries(components).map(async ([componentName, content]) => {
      const filePath = getComponentFilePath(componentsFolder, componentName);
      await writeFileRecursive(filePath, content.code, { encoding: 'utf-8' });
    }),
  );
}

function mergeComponentsContentIntoDom(
  dom: appDom.AppDom,
  componentsContent: ComponentsContent,
): appDom.AppDom {
  const rootNode = appDom.getApp(dom);
  const { codeComponents: codeComponentNodes = [] } = appDom.getChildNodes(dom, rootNode);
  const names = new Set([
    ...Object.keys(componentsContent),
    ...codeComponentNodes.map((node) => node.name),
  ]);

  for (const name of names) {
    const content: { code: string } | undefined = componentsContent[name];
    const codeComponentNode = codeComponentNodes.find((node) => node.name === name);
    if (content) {
      if (codeComponentNode) {
        dom = appDom.setNodeNamespacedProp(
          dom,
          codeComponentNode,
          'attributes',
          'code',
          content.code,
        );
      } else {
        const newNode = appDom.createNode(dom, 'codeComponent', {
          name,
          attributes: {
            code: content.code,
          },
        });
        dom = appDom.addNode(dom, newNode, rootNode, 'codeComponents');
      }
    } else if (codeComponentNode) {
      dom = appDom.removeNode(dom, codeComponentNode.id);
    }
  }

  return dom;
}

function mergeThemeIntoAppDom(dom: appDom.AppDom, themeFile: Theme): appDom.AppDom {
  const themeFileSpec = themeFile.spec;
  const app = appDom.getApp(dom);
  dom = appDom.addNode(
    dom,
    appDom.createNode(dom, 'theme', {
      theme: themeFileSpec.options,
      attributes: {},
    }),
    app,
    'themes',
  );
  return dom;
}

function stringOnly(maybeString: unknown): string | undefined {
  return typeof maybeString === 'string' ? maybeString : undefined;
}

function expandChildren(children: appDom.ElementNode[], dom: appDom.AppDom): ElementType[];
function expandChildren(children: appDom.QueryNode[], dom: appDom.AppDom): Query[];
function expandChildren<N extends appDom.AppDomNode>(
  children: N[],
  dom: appDom.AppDom,
): (Query | ElementType)[];
function expandChildren<N extends appDom.AppDomNode>(children: N[], dom: appDom.AppDom) {
  return (
    children
      .sort((child1, child2) => {
        invariant(
          child1.parentIndex && child2.parentIndex,
          'Nodes are not children of another node',
        );
        return appDom.compareFractionalIndex(child1.parentIndex, child2.parentIndex);
      })
      // eslint-disable-next-line @typescript-eslint/no-use-before-define
      .map((child) => expandFromDom(child, dom))
  );
}

function undefinedWhenEmpty<O extends object | any[]>(obj?: O): O | undefined {
  if (!obj || Object.values(obj).every((property) => property === undefined)) {
    return undefined;
  }
  return obj;
}

function createPageFileQueryFromDomQuery(
  dataSource: string,
  query: FetchQuery | LocalQuery | undefined,
): QueryConfig {
  switch (dataSource) {
    case 'rest': {
      if (!query) {
        return { kind: 'rest' };
      }
      query = query as FetchQuery;

      let body: FetchBody | undefined;

      if (query.body) {
        switch (query.body.kind) {
          case 'raw': {
            body = {
              kind: 'raw',
              content: query.body.content as PropBindableAttrValue<string>,
              contentType: query.body.contentType,
            };
            break;
          }
          case 'urlEncoded': {
            body = {
              kind: 'urlEncoded',
              content: query.body.content.map(([name, value]) => ({
                name,
                value: value as PropBindableAttrValue<string>,
              })),
            };
            break;
          }
          default:
            throw new Error(`Unrecognized body kind "${(query.body as any).kind}"`);
        }
      }

      let response: ResponseType | undefined;

      if (query.response) {
        switch (query.response.kind) {
          case 'csv': {
            response = { kind: 'csv', headers: query.response.headers };
            break;
          }
          case 'json': {
            response = { kind: 'json' };
            break;
          }
          case 'xml': {
            response = { kind: 'xml' };
            break;
          }
          case 'raw': {
            response = { kind: 'raw' };
            break;
          }
          default:
            throw new Error(`Unrecognized response kind "${(query.response as any).kind}"`);
        }
      }

      return {
        kind: 'rest',
        url: query.url as PropBindableAttrValue<string>,
        searchParams: query.searchParams?.map(([name, value]) => ({
          name,
          value: value as PropBindableAttrValue<string>,
        })),
        headers: query.headers.map(([name, value]) => ({
          name,
          value: value as PropBindableAttrValue<string>,
        })),
        body,
        method: query.method,
        response,
        transform: query.transform,
        transformEnabled: query.transformEnabled,
      } satisfies FetchQueryConfig;
    }
    case 'local':
      if (!query) {
        return { kind: 'local' };
      }

      query = query as LocalQuery;
      return {
        function: query.function,
        kind: 'local',
      } satisfies LocalQueryConfig;
    default:
      throw new Error(`Unsupported dataSource "${dataSource}"`);
  }
}

function expandFromDom(node: appDom.ElementNode, dom: appDom.AppDom): ElementType;
function expandFromDom(node: appDom.QueryNode, dom: appDom.AppDom): Query;
function expandFromDom(node: appDom.PageNode, dom: appDom.AppDom): Page;
function expandFromDom<N extends appDom.AppDomNode>(
  node: N,
  dom: appDom.AppDom,
): Page | Query | ElementType;
function expandFromDom<N extends appDom.AppDomNode>(
  node: N,
  dom: appDom.AppDom,
): Page | Query | ElementType {
  if (appDom.isPage(node)) {
    const children = appDom.getChildNodes(dom, node);

    return {
      apiVersion: API_VERSION,
      kind: 'page',
      spec: {
        id: node.id,
        title: node.attributes.title,
        parameters: undefinedWhenEmpty(
          node.attributes.parameters?.map(([name, value]) => ({ name, value })) ?? [],
        ),
        content: undefinedWhenEmpty(expandChildren(children.children || [], dom)),
        queries: undefinedWhenEmpty(expandChildren(children.queries || [], dom)),
        display: node.attributes.display,
      },
    } satisfies Page;
  }

  if (appDom.isQuery(node)) {
    return {
      name: node.name,
      enabled: node.attributes.enabled as PropBindableAttrValue<boolean>,
      mode: node.attributes.mode,
      query: node.attributes.dataSource
        ? createPageFileQueryFromDomQuery(
            node.attributes.dataSource,
            node.attributes.query as FetchQuery | LocalQuery | undefined,
          )
        : undefined,
      parameters: undefinedWhenEmpty(node.params?.map(([name, value]) => ({ name, value }))),
      cacheTime: node.attributes.cacheTime,
      refetchInterval: node.attributes.refetchInterval,
      transform: node.attributes.transform,
      transformEnabled: node.attributes.transformEnabled,
    } satisfies Query;
  }

  if (appDom.isElement(node)) {
    const { children, ...templates } = appDom.getChildNodes(dom, node);

    const templateProps = mapValues(templates, (subtree) =>
      subtree
        ? {
            $$template: expandChildren(subtree, dom),
          }
        : undefined,
    );

    return {
      component: node.attributes.component,
      name: node.name,
      layout: undefinedWhenEmpty({
        columnSize: node.layout?.columnSize,
        horizontalAlign: stringOnly(node.layout?.horizontalAlign),
        verticalAlign: stringOnly(node.layout?.verticalAlign),
      }),
      props: undefinedWhenEmpty({ ...node.props, ...templateProps }),
      children: undefinedWhenEmpty(expandChildren(children || [], dom)),
    } satisfies ElementType;
  }

  throw new Error(`Unsupported node type "${node.type}"`);
}

function isTemplate(bindableProp?: BindableProp): bindableProp is Template {
  return !!(
    bindableProp &&
    typeof bindableProp === 'object' &&
    hasOwnProperty(bindableProp, '$$template')
  );
}

function mergeElementIntoDom(
  dom: appDom.AppDom,
  parent: appDom.ElementNode | appDom.PageNode,
  parentProp: string,
  elm: ElementType,
): appDom.AppDom {
  const plainProps = filterValues(elm.props ?? {}, (prop) => !isTemplate(prop)) as Record<
    string,
    Exclude<BindableProp, Template>
  >;

  const templateProps = filterValues(elm.props ?? {}, isTemplate) as Record<string, Template>;

  const elmNode = appDom.createElement(dom, elm.component, plainProps, elm.layout ?? {}, elm.name);

  dom = appDom.addNode(dom, elmNode, parent, parentProp as any);

  if (elm.children) {
    for (const child of elm.children) {
      dom = mergeElementIntoDom(dom, elmNode, 'children', child);
    }
  }

  for (const [propName, templateProp] of Object.entries(templateProps)) {
    for (const child of templateProp.$$template) {
      dom = mergeElementIntoDom(dom, elmNode, propName, child);
    }
  }

  return dom;
}

function createDomQueryFromPageFileQuery(query: QueryConfig): FetchQuery | LocalQuery {
  switch (query.kind) {
    case 'local':
      return {
        function: query.function,
      } satisfies LocalQuery;
    case 'rest': {
      let body: AppDomFetchBody | undefined;

      if (query.body) {
        switch (query.body.kind) {
          case 'raw': {
            body = {
              kind: 'raw',
              content: query.body.content,
              contentType: query.body.contentType,
            };
            break;
          }
          case 'urlEncoded': {
            body = {
              kind: 'urlEncoded',
              content: query.body.content.map(({ name, value }) => [
                name,
                value as PropBindableAttrValue<string>,
              ]),
            };
            break;
          }
          default:
            throw new Error(`Unrecognized body kind "${(query.body as any).kind}"`);
        }
      }

      let response: AppDomRestResponseType | undefined;

      if (query.response) {
        switch (query.response.kind) {
          case 'csv': {
            response = { kind: 'csv', headers: query.response.headers };
            break;
          }
          case 'json': {
            response = { kind: 'json' };
            break;
          }
          case 'xml': {
            response = { kind: 'xml' };
            break;
          }
          case 'raw': {
            response = { kind: 'raw' };
            break;
          }
          default:
            throw new Error(`Unrecognized response kind "${(query.response as any).kind}"`);
        }
      }

      return {
        url: query.url || undefined,
        headers: query.headers?.map(({ name, value }) => [name, value]) || [],
        method: query.method || 'GET',
        browser: false,
        transform: query.transform,
        transformEnabled: query.transformEnabled,
        searchParams: query.searchParams?.map(({ name, value }) => [name, value]) || [],
        body,
        response,
      } satisfies FetchQuery;
    }
    default:
      throw new Error(`Unrecognized query kind "${(query as any).kind}"`);
  }
}

function createPageDomFromPageFile(pageName: string, pageFile: Page): appDom.AppDom {
  const pageFileSpec = pageFile.spec;
  let fragment = appDom.createFragmentInternal(pageFileSpec.id as NodeId, 'page', {
    name: pageName,
    attributes: {
      title: pageFileSpec.title || '',
      parameters: pageFileSpec.parameters?.map(({ name, value }) => [name, value]) || [],
      display: pageFileSpec.display || undefined,
    },
  });

  const pageNode = appDom.getRoot(fragment);
  appDom.assertIsPage(pageNode);

  if (pageFileSpec.queries) {
    for (const query of pageFileSpec.queries) {
      if (query.query) {
        const queryNode = appDom.createNode(fragment, 'query', {
          name: query.name,
          attributes: {
            connectionId: null,
            dataSource: typeof query.query?.kind === 'string' ? query.query.kind : undefined,
            query: createDomQueryFromPageFileQuery(query.query),
            cacheTime: typeof query.cacheTime === 'number' ? query.cacheTime : undefined,
            enabled: query.enabled ?? undefined,
            mode: typeof query.mode === 'string' ? query.mode : undefined,
            transform: typeof query.transform === 'string' ? query.transform : undefined,
            refetchInterval:
              typeof query.refetchInterval === 'number' ? query.refetchInterval : undefined,
            transformEnabled: query.transformEnabled ?? undefined,
          },
          params: query.parameters?.map(
            ({ name, value }) => [name, value] satisfies [string, BindableAttrValue<any>],
          ),
        });
        fragment = appDom.addNode(fragment, queryNode, pageNode, 'queries');
      }
    }
  }

  if (pageFileSpec.content) {
    for (const child of pageFileSpec.content) {
      fragment = mergeElementIntoDom(fragment, pageNode, 'children', child);
    }
  }

  return fragment;
}

function mergePageIntoDom(dom: appDom.AppDom, pageName: string, pageFile: Page): appDom.AppDom {
  const appRoot = appDom.getRoot(dom);
  const pageFragment = createPageDomFromPageFile(pageName, pageFile);

  const newPageNode = appDom.getRoot(pageFragment);

  if (appDom.getMaybeNode(dom, newPageNode.id)) {
    dom = appDom.removeNode(dom, newPageNode.id);
  }

  dom = appDom.addFragment(dom, pageFragment, appRoot.id, 'pages');

  return dom;
}

function mergePagesIntoDom(dom: appDom.AppDom, pages: PagesContent): appDom.AppDom {
  for (const [name, page] of Object.entries(pages)) {
    dom = mergePageIntoDom(dom, name, page);
  }
  return dom;
}

type PagesContent = Record<string, Page>;

interface ExtractedPages {
  pages: PagesContent;
  dom: appDom.AppDom;
}

function extractPagesFromDom(dom: appDom.AppDom): ExtractedPages {
  const rootNode = appDom.getApp(dom);
  const { pages: pageNodes = [] } = appDom.getChildNodes(dom, rootNode);

  const pages: PagesContent = {};

  for (const pageNode of pageNodes) {
    pages[pageNode.name] = expandFromDom(pageNode, dom);
    dom = appDom.removeNode(dom, pageNode.id);
  }

  return { pages, dom };
}

function extractThemeFromDom(dom: appDom.AppDom): Theme | null {
  const rootNode = appDom.getApp(dom);
  const { themes: themeNodes = [] } = appDom.getChildNodes(dom, rootNode);
  if (themeNodes.length > 0) {
    return {
      apiVersion: API_VERSION,
      kind: 'theme',
      spec: {
        options: themeNodes[0].theme,
      },
    };
  }

  return null;
}

async function writePagesToFiles(root: string, pages: PagesContent) {
  await Promise.all(
    Object.entries(pages).map(async ([name, page]) => {
      const pageFileName = getPageFile(root, name);
      await updateYamlFile(pageFileName, page);
    }),
  );
}

async function writeThemeFile(root: string, theme: Theme | null) {
  const themeFilePath = getThemeFile(root);
  if (theme) {
    await updateYamlFile(themeFilePath, theme);
  } else {
    await fs.rm(themeFilePath, { recursive: true, force: true });
  }
}

async function writeDomToDisk(root: string, dom: appDom.AppDom): Promise<void> {
  const { pages: pagesContent } = extractPagesFromDom(dom);
  await Promise.all([
    writePagesToFiles(root, pagesContent),
    writeThemeFile(root, extractThemeFromDom(dom)),
  ]);
}

const DEFAULT_EDITOR = 'code';

export async function findSupportedEditor(): Promise<string | null> {
  const maybeEditor = process.env.EDITOR ?? DEFAULT_EDITOR;
  if (!maybeEditor) {
    return null;
  }
  try {
    await execa(maybeEditor, ['-v']);
    return maybeEditor;
  } catch (err) {
    return null;
  }
}

export type ProjectFolderEntry = {
  name: string;
  kind: 'query';
  filepath: string;
};

interface ToolpadProjectFolder {
  pages: Record<string, Page>;
  components: Record<string, { code: string }>;
  theme: Theme | null;
}

async function readProjectFolder(root: string): Promise<ToolpadProjectFolder> {
  const [componentsContent, pagesContent, theme] = await Promise.all([
    loadCodeComponentsFromFiles(root),
    loadPagesFromFiles(root),
    loadThemeFromFile(root),
  ]);

  return {
    pages: pagesContent,
    components: componentsContent,
    theme,
  };
}

async function writeProjectFolder(
  root: string,
  folder: ToolpadProjectFolder,
  writeComponents: boolean = false,
): Promise<void> {
  await writePagesToFiles(root, folder.pages);
  await writeThemeFile(root, folder.theme);
  if (writeComponents) {
    const componentsFolder = getComponentsFolder(root);
    await writeCodeComponentsToFiles(componentsFolder, folder.components);
  }
}

function projectFolderToAppDom(projectFolder: ToolpadProjectFolder): appDom.AppDom {
  let dom = appDom.createDom();
  dom = mergePagesIntoDom(dom, projectFolder.pages);
  dom = mergeComponentsContentIntoDom(dom, projectFolder.components);
  if (projectFolder.theme) {
    dom = mergeThemeIntoAppDom(dom, projectFolder.theme);
  }
  return dom;
}

async function loadProjectFolder(root: string): Promise<ToolpadProjectFolder> {
  return readProjectFolder(root);
}

export async function loadDomFromDisk(root: string): Promise<appDom.AppDom> {
  const projectFolder = await loadProjectFolder(root);

  return projectFolderToAppDom(projectFolder);
}

async function migrateLegacyProject(root: string) {
  const isLegacyProject = await legacyConfigFileExists(root);

  if (isLegacyProject) {
    console.error(
      `${chalk.red(
        'error',
      )} - This project was created with a deprecated version of Toolpad, please use @mui/toolpad@0.1.17 to migrate this project`,
    );
    process.exit(1);
  }
}

function getDomFilePatterns(root: string) {
  return [
    path.resolve(root, './toolpad/pages/*/page.yml'),
    path.resolve(root, './toolpad/components/*.*'),
  ];
}
/**
 * Calculates a fingerprint from all files that influence the dom structure
 */
async function calculateDomFingerprint(root: string): Promise<number> {
  const files = await glob(getDomFilePatterns(root), { windowsPathsNoEscape: true });

  const mtimes = await Promise.all(
    files.sort().map(async (file) => {
      const stats = await fs.stat(file);
      return [file, stats.mtimeMs];
    }),
  );

  return insecureHash(JSON.stringify(mtimes));
}

async function initToolpadFolder(root: string) {
  const projectFolder = await readProjectFolder(root);
  if (Object.keys(projectFolder.pages).length <= 0) {
    projectFolder.pages.page = {
      apiVersion: API_VERSION,
      kind: 'page',
      spec: {
        id: appDom.createId(),
        title: 'Default page',
      },
    };
    await writeProjectFolder(root, projectFolder);
  }

  await initGitignore(root);
}

function getCodeComponentsFingerprint(dom: appDom.AppDom) {
  const { codeComponents = [] } = appDom.getChildNodes(dom, appDom.getApp(dom));
  return codeComponents.map(({ name }) => name).join('|');
}

class ToolpadProject {
  private root: string;

  events = new Emitter<ProjectEvents>();

  private domAndFingerprint: Awaitable<[appDom.AppDom, number]> | null = null;

  private domAndFingerprintLock = new Lock();

  options: ToolpadProjectOptions;

  private codeComponentsFingerprint: null | string = null;

  envManager: EnvManager;

  functionsManager: FunctionsManager;

  dataManager: DataManager;

  invalidateQueries: () => void;

  private alertedMissingVars = new Set<string>();

  private lastVersionCheck = 0;

  private pendingVersionCheck: Promise<VersionInfo> | undefined;

  constructor(root: string, options: Partial<ToolpadProjectOptions>) {
    this.root = root;
    this.options = {
      cmd: 'start',
      dev: false,
      ...options,
    };

    this.envManager = new EnvManager(this);
    this.functionsManager = new FunctionsManager(this);
    this.dataManager = new DataManager(this);

    this.invalidateQueries = throttle(
      () => {
        this.events.emit('queriesInvalidated', {});
      },
      250,
      {
        leading: false,
      },
    );
  }

  private initWatcher() {
    if (!this.options.dev) {
      return;
    }

    const updateDomFromExternal = debounce(() => {
      this.domAndFingerprintLock.use(async () => {
        const [dom, fingerprint] = await this.loadDomAndFingerprint();
        const newFingerprint = await calculateDomFingerprint(this.root);
        if (fingerprint !== newFingerprint) {
          // eslint-disable-next-line no-console
          console.log(`${chalk.magenta('event')} - Project changed on disk, updating...`);
          this.domAndFingerprint = await Promise.all([
            loadDomFromDisk(this.root),
            calculateDomFingerprint(this.root),
          ]);
          this.events.emit('change', { fingerprint });
          this.events.emit('externalChange', { fingerprint });

          const newCodeComponentsFingerprint = getCodeComponentsFingerprint(dom);
          if (this.codeComponentsFingerprint !== newCodeComponentsFingerprint) {
            this.codeComponentsFingerprint = newCodeComponentsFingerprint;
            if (this.codeComponentsFingerprint !== null) {
              this.events.emit('componentsListChanged', {});
            }
          }
        }
      });
    }, 100);

    const watchOptions: chokidar.WatchOptions = {
      // This is needed to correctly pick up page folder renames
      // Remove this once https://github.com/paulmillr/chokidar/issues/1285 gets resolved
      usePolling: true,
    };

    chokidar.watch(getDomFilePatterns(this.root), watchOptions).on('all', () => {
      updateDomFromExternal();
    });
  }

  private async loadDomAndFingerprint() {
    if (!this.domAndFingerprint) {
      this.domAndFingerprint = Promise.all([
        loadDomFromDisk(this.root),
        calculateDomFingerprint(this.root),
      ]);
    }
    return this.domAndFingerprint;
  }

  getRoot() {
    return this.root;
  }

  getToolpadFolder() {
    return getToolpadFolder(this.getRoot());
  }

  getOutputFolder() {
    return getOutputFolder(this.getRoot());
  }

  alertOnMissingVariablesInDom(dom: appDom.AppDom) {
    const requiredVars = appDom.getRequiredEnvVars(dom);
    const missingVars = Array.from(requiredVars).filter(
      (key) => typeof process.env[key] === 'undefined',
    );
    const toAlert = missingVars.filter((key) => !this.alertedMissingVars.has(key));

    if (toAlert.length > 0) {
      const firstThree = toAlert.slice(0, 3);
      const restCount = toAlert.length - firstThree.length;
      const missingListMsg = firstThree.map((varName) => chalk.cyan(varName)).join(', ');
      const restMsg = restCount > 0 ? ` and ${restCount} more` : '';

      // eslint-disable-next-line no-console
      console.log(
        `${chalk.yellow(
          'warn',
        )}  - Missing required environment variable(s): ${missingListMsg}${restMsg}.`,
      );
    }

    // Only alert once per missing variable
    this.alertedMissingVars = new Set(missingVars);
  }

  async start() {
    if (this.options.dev) {
      await this.initWatcher();
    }
    await Promise.all([this.envManager.start(), this.functionsManager.start()]);
  }

  async build() {
    await Promise.all([this.envManager.build(), this.functionsManager.build()]);
  }

  async dispose() {
    await Promise.all([this.envManager.dispose(), this.functionsManager.dispose()]);
  }

  async loadDom() {
    const [dom] = await this.loadDomAndFingerprint();
    this.alertOnMissingVariablesInDom(dom);
    return dom;
  }

  async writeDomToDisk(newDom: appDom.AppDom) {
    if (!this.options.dev) {
      throw new Error(`Writing to disk is only possible in toolpad dev mode.`);
    }

    await writeDomToDisk(this.root, newDom);
    const newFingerprint = await calculateDomFingerprint(this.root);
    this.domAndFingerprint = [newDom, newFingerprint];
    this.events.emit('change', { fingerprint: newFingerprint });
    return { fingerprint: newFingerprint };
  }

  async saveDom(newDom: appDom.AppDom) {
    return this.domAndFingerprintLock.use(async () => {
      return this.writeDomToDisk(newDom);
    });
  }

  async applyDomDiff(domDiff: appDom.DomDiff) {
    return this.domAndFingerprintLock.use(async () => {
      const dom = await this.loadDom();
      const newDom = appDom.applyDiff(dom, domDiff);
      return this.writeDomToDisk(newDom);
    });
  }

  async openCodeEditor(fileName: string, fileType: string) {
    const supportedEditor = await findSupportedEditor();
    if (!supportedEditor) {
      throw new Error(`No code editor found`);
    }
    const root = this.getRoot();
    let resolvedPath = fileName;

    if (fileType === 'query') {
      resolvedPath = await this.functionsManager.getFunctionFilePath(fileName);
    }
    if (fileType === 'component') {
      const componentsFolder = getComponentsFolder(root);
      resolvedPath = getComponentFilePath(componentsFolder, fileName);
    }
    const fullResolvedPath = path.resolve(root, resolvedPath);
    openEditor([fullResolvedPath, root], {
      editor: process.env.EDITOR ? undefined : DEFAULT_EDITOR,
    });
  }

  async getVersionInfo(): Promise<VersionInfo> {
    const now = Date.now();
    if (!this.pendingVersionCheck || this.lastVersionCheck + VERSION_CHECK_INTERVAL <= now) {
      this.lastVersionCheck = now;
      this.pendingVersionCheck = checkVersion(this.root);
    }

    return this.pendingVersionCheck;
  }

  async createComponent(name: string) {
    const componentsFolder = getComponentsFolder(this.root);
    const filePath = getComponentFilePath(componentsFolder, name);
    const content = createDefaultCodeComponent(name);
    await writeFileRecursive(filePath, content, { encoding: 'utf-8' });
  }

  async deletePage(name: string) {
    const pageFolder = getPageFolder(this.root, name);
    await fs.rm(pageFolder, { force: true, recursive: true });
  }

  getRuntimeConfig(): RuntimeConfig {
    return {
      externalUrl:
        process.env.TOOLPAD_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`,
      projectDir: this.getRoot(),
      cmd: this.options.dev ? 'dev' : 'start',
    };
  }
}

export type { ToolpadProject };

declare global {
  // eslint-disable-next-line
  var __toolpadProject: ToolpadProject | undefined;
}

export async function initProject(cmd: 'dev' | 'start' | 'build', root: string) {
  // eslint-disable-next-line no-underscore-dangle
  invariant(!global.__toolpadProject, 'A project is already running');

  await migrateLegacyProject(root);

  await initToolpadFolder(root);

  const project = new ToolpadProject(root, { cmd, dev: cmd === 'dev' });
  // eslint-disable-next-line no-underscore-dangle
  globalThis.__toolpadProject = project;

  return project;
}
