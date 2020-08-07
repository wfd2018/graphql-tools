import { GraphQLCompositeType, GraphQLError, GraphQLSchema, isAbstractType, GraphQLResolveInfo } from 'graphql';

import { setErrors, slicedError } from '@graphql-tools/utils';

import { SubschemaConfig } from '../types';

import { setObjectSubschema } from '../Subschema';

import { mergeFields } from './mergeFields';
import { getFieldsNotInSubschema } from './getFieldsNotInSubschema';

export function handleObject(
  type: GraphQLCompositeType,
  object: any,
  errors: ReadonlyArray<GraphQLError>,
  subschema: GraphQLSchema | SubschemaConfig,
  context: Record<string, any>,
  info: GraphQLResolveInfo,
  skipTypeMerging?: boolean
) {
  const stitchingInfo = info?.schema.extensions?.stitchingInfo;

  setErrors(
    object,
    errors.map(error => slicedError(error))
  );

  setObjectSubschema(object, subschema);

  if (skipTypeMerging || !stitchingInfo) {
    return object;
  }

  const typeName = isAbstractType(type) ? info.schema.getTypeMap()[object.__typename].name : type.name;
  const mergedTypeInfo = stitchingInfo.mergedTypes[typeName];
  let targetSubschemas: Array<SubschemaConfig>;

  if (mergedTypeInfo != null) {
    targetSubschemas = mergedTypeInfo.targetSubschemas.get(subschema);
  }

  if (!targetSubschemas) {
    return object;
  }

  const fieldNodes = getFieldsNotInSubschema(info, subschema, mergedTypeInfo);

  return mergeFields(
    mergedTypeInfo,
    typeName,
    object,
    fieldNodes,
    subschema as SubschemaConfig,
    targetSubschemas,
    context,
    info
  );
}
