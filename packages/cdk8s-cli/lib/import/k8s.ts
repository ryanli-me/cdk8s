import { CodeMaker } from 'codemaker';
import { JSONSchema4 } from 'json-schema';
import { ImportBase } from './base';
import { ApiObjectName, parseApiTypeName, compareApiVersions } from './k8s-util';
import { ImportSpec } from '../config';
import { download } from '../util';
import { TypeGenerator } from 'json2jsii';
import { generateConstruct } from './codegen';

const DEFAULT_API_VERSION = '1.15.0';

export interface ImportKubernetesApiOptions {
  /**
   * The API version to generate.
   */
  readonly apiVersion: string;

  /**
   * FQNs of API object types to select instead of selecting the latest stable
   * version.
   * 
   * @default - selects the latest stable version from each API object
   */
  readonly include?: string[];

  /**
   * Do not import these types. Instead, represent them as "any".
   * 
   * @default - include all types that derive from the root types.
   */
  readonly exclude?: string[];
}

export class ImportKubernetesApi extends ImportBase {

  public static async match(importSpec: ImportSpec, argv: any): Promise<ImportKubernetesApiOptions | undefined> {
    const { source } = importSpec;
    if (source !== 'k8s' && !source.startsWith('k8s@')) {
      return undefined;
    }

    return {
      apiVersion: source.split('@')[1] ?? DEFAULT_API_VERSION,
      exclude: argv.exclude,
      include: argv.include
    };
  }

  constructor(private readonly options: ImportKubernetesApiOptions) {
    super()
  }

  public get moduleNames() {
    return ['k8s'];
  }

  protected async generateTypeScript(code: CodeMaker) {
    const schema = await downloadSchema(this.options.apiVersion);
    const map = findApiObjectDefinitions(schema);
  
    const topLevelObjects = selectApiObjects(map, { include: this.options.include });
  
  
    const typeGenerator = new TypeGenerator({
      definitions: schema.definitions,
      exclude: this.options.exclude
    });
  
    for (const o of topLevelObjects) {
      this.emitConstructForApiObject(typeGenerator, o);
    }
  
    code.line(`// generated by cdk8s`);
    code.line(`import { ApiObject } from 'cdk8s';`);
    code.line(`import { Construct } from 'constructs';`);
    code.line();

    code.line(typeGenerator.render());
  }

  private emitConstructForApiObject(typeGenerator: TypeGenerator, apidef: ApiObjectDefinition) {
    const objectName = getObjectName(apidef);
    generateConstruct(typeGenerator, {
      fqn: apidef.fullname,
      group: objectName.group,
      kind: objectName.kind,
      version: objectName.version,
      schema: apidef.schema
    });
  }
}



export interface SelectApiObjectsOptions {
  include?: string[];
}

export function selectApiObjects(map: ApiObjectDefinitions, options: SelectApiObjectsOptions = { }): ApiObjectDefinition[] {
  const result = new Array<ApiObjectDefinition>();
  const include = options.include ?? [];
  for (const defs of Object.values(map)) {
    defs.sort((lhs, rhs) => compareApiVersions(lhs, rhs));


    let selected = defs[defs.length - 1];

    const included = defs.find(x => include.includes(x.fullname));
    if (included) {
      selected = included; 
    }

    // select latest stable version
    result.push(selected);
  }

  return result;
}

/**
 * Returns a map of all API objects in the spec (objects that have the
 * 'x-kubernetes-group-version-kind' annotation).
 *
 * The key is the base name of the type (i.e. `Deployment`). Since API objects
 * may have multiple versions, each value in the map is an array of type definitions
 * along with version information.
 * 
 * @see https://kubernetes.io/docs/concepts/overview/kubernetes-api/#api-versioning
 */
export function findApiObjectDefinitions(schema: JSONSchema4): ApiObjectDefinitions {
  const map: ApiObjectDefinitions = { };

  for (const [ typename, def ] of Object.entries(schema.definitions || { })) {
    const kinds = tryGetObjectName(def);
    if (!kinds) {
      continue;
    }

    const type = parseApiTypeName(typename);
    const list = map[type.basename] ?? [];
    map[type.basename] = list;
    list.push({
      ...type,
      schema: def
    });
  }

  return map;
}

type ApiObjectDefinitions = { [basename: string]: ApiObjectDefinition[] };


interface ApiObjectDefinition extends ApiObjectName {
  schema: JSONSchema4;
}

function tryGetObjectName(def: JSONSchema4): GroupVersionKind | undefined {
  const objectNames = def[X_GROUP_VERSION_KIND] as GroupVersionKind[];
  if (!objectNames) {
    return undefined;
  }

  const objectName = objectNames[0];
  if (!objectName) {
    return undefined;
  }

  // skip definitions without "metadata". they are not API objects that can be defined
  // in manifests (example: io.k8s.apimachinery.pkg.apis.meta.v1.DeleteOptions)
  // they will be treated as data types
  if (!def.properties?.metadata) {
    return undefined;
  }
  
  return objectName;
}

function getObjectName(apiDefinition: ApiObjectDefinition): GroupVersionKind {
  const objectName = tryGetObjectName(apiDefinition.schema);
  if (!objectName) {
    throw new Error(`cannot determine API object name for ${apiDefinition.fullname}. schema must include a ${X_GROUP_VERSION_KIND} key`);
  }

  return objectName;
}


interface GroupVersionKind {
  readonly group: string;
  readonly kind: string;
  readonly version: string;
}

const X_GROUP_VERSION_KIND = 'x-kubernetes-group-version-kind';

async function downloadSchema(apiVersion: string) {
  const url = `https://raw.githubusercontent.com/instrumenta/kubernetes-json-schema/master/v${apiVersion}/_definitions.json`
  const output = await download(url);
  return JSON.parse(output) as JSONSchema4;
}