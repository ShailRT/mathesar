import {
  type Readable,
  type Writable,
  derived,
  get,
  writable,
} from 'svelte/store';

import type { RequestStatus } from '@mathesar/api/rest/utils/requestUtils';
import { api } from '@mathesar/api/rpc';
import type { RawSchema } from '@mathesar/api/rpc/schemas';
import type { Database } from '@mathesar/models/Database';
import { Schema } from '@mathesar/models/Schema';
import { getErrorMessage } from '@mathesar/utils/errors';
import { preloadCommonData } from '@mathesar/utils/preloadData';
import { type CancellablePromise, collapse } from '@mathesar-component-library';

import { databasesStore } from './databases';

const commonData = preloadCommonData();

export const currentSchemaId: Writable<Schema['oid'] | undefined> = writable(
  commonData.current_schema ?? undefined,
);

export interface SchemaStoreData {
  databaseId?: Database['id'];
  requestStatus: RequestStatus;
  data: Map<Schema['oid'], Schema>;
}

function makeEmptySchemasData(): SchemaStoreData {
  return {
    requestStatus: { state: 'success' },
    data: new Map(),
  };
}

const schemasStore: Writable<SchemaStoreData> = writable(
  makeEmptySchemasData(),
);

let request: CancellablePromise<RawSchema[]>;

function setSchemasInStore(database: Database, rawSchemas: RawSchema[]) {
  const schemasMap = new Map<Schema['oid'], Schema>();
  rawSchemas.forEach((rawSchema) => {
    schemasMap.set(rawSchema.oid, new Schema({ database, rawSchema }));
  });
  schemasStore.set({
    databaseId: database.id,
    requestStatus: { state: 'success' },
    data: schemasMap,
  });
}

function updateSchemaInStore(database: Database, schema: Schema) {
  const $schemasStore = get(schemasStore);
  if ($schemasStore.databaseId === database.id) {
    schemasStore.update((value) => {
      value.data?.set(schema.oid, schema);
      return {
        ...value,
        data: new Map(value.data),
      };
    });
  }
}

function removeSchemaInStore(database: Database, schema: Schema) {
  const $schemasStore = get(schemasStore);
  if ($schemasStore.databaseId === database.id) {
    schemasStore.update((value) => {
      value.data?.delete(schema.oid);
      return {
        ...value,
        data: new Map(value.data),
      };
    });
  }
}

export async function fetchSchemasForCurrentDatabase() {
  request?.cancel();
  const $currentDatabase = get(databasesStore.currentDatabase);
  if (!$currentDatabase) {
    schemasStore.set(makeEmptySchemasData());
    return;
  }

  schemasStore.update(($schemasStore) => {
    if ($schemasStore.databaseId === $currentDatabase.id) {
      return {
        ...$schemasStore,
        requestStatus: { state: 'processing' },
      };
    }
    return {
      databaseId: $currentDatabase.id,
      requestStatus: { state: 'processing' },
      data: new Map(),
    };
  });

  try {
    request = api.schemas.list({ database_id: $currentDatabase.id }).run();
    const rawSchemas = await request;
    setSchemasInStore($currentDatabase, rawSchemas);
  } catch (err) {
    schemasStore.update(($schemasStore) => {
      if ($schemasStore.databaseId === $currentDatabase.id) {
        return {
          ...$schemasStore,
          requestStatus: { state: 'failure', errors: [getErrorMessage(err)] },
        };
      }
      return {
        databaseId: $currentDatabase.id,
        requestStatus: { state: 'failure', errors: [getErrorMessage(err)] },
        data: new Map(),
      };
    });
  }
}

export async function createSchema(
  database: Database,
  props: {
    name: string;
    description: string | null;
  },
): Promise<void> {
  const rawSchema = await api.schemas
    .add({
      database_id: database.id,
      name: props.name,
      description: props.description,
    })
    .run();
  updateSchemaInStore(database, new Schema({ database, rawSchema }));
}

export async function deleteSchema(schema: Schema): Promise<void> {
  await schema.delete();
  removeSchemaInStore(schema.database, schema);
}

let preload = true;

export const schemas = collapse(
  derived(databasesStore.currentDatabase, ($currentDatabase) => {
    const $schemasStore = get(schemasStore);
    if ($schemasStore.databaseId !== $currentDatabase?.id) {
      if (preload && commonData.current_database === $currentDatabase?.id) {
        setSchemasInStore($currentDatabase, commonData.schemas);
      } else {
        void fetchSchemasForCurrentDatabase();
      }
      preload = false;
    } else if ($schemasStore.requestStatus.state === 'failure') {
      void fetchSchemasForCurrentDatabase();
    }
    return schemasStore;
  }),
);

export const currentSchema: Readable<Schema | undefined> = derived(
  [currentSchemaId, schemas],
  ([$currentSchemaId, $schemas]) =>
    $currentSchemaId ? $schemas.data.get($currentSchemaId) : undefined,
);
