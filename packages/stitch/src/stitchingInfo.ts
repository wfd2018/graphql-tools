import {
  GraphQLObjectType,
  GraphQLSchema,
  Kind,
  SelectionSetNode,
  isObjectType,
  isScalarType,
  getNamedType,
  GraphQLOutputType,
  GraphQLInterfaceType,
} from 'graphql';

import {
  parseFragmentToInlineFragment,
  concatInlineFragments,
  typeContainsSelectionSet,
  parseSelectionSet,
  TypeMap,
  IResolvers,
  IFieldResolverOptions,
} from '@graphql-tools/utils';

import { delegateToSchema, isSubschemaConfig, SubschemaConfig } from '@graphql-tools/delegate';
import { createBatchDelegateFn } from '@graphql-tools/batch-delegate';

import { MergeTypeCandidate, MergedTypeInfo, StitchingInfo, MergeTypeFilter } from './types';

export function createStitchingInfo(
  transformedSchemas: Map<GraphQLSchema | SubschemaConfig, GraphQLSchema>,
  typeCandidates: Record<string, Array<MergeTypeCandidate>>,
  mergeTypes?: boolean | Array<string> | MergeTypeFilter
): StitchingInfo {
  const mergedTypes = createMergedTypes(typeCandidates, mergeTypes);
  const selectionSetsByField: Record<string, Record<string, SelectionSetNode>> = Object.entries(mergedTypes).reduce(
    (acc, [typeName, mergedTypeInfo]) => {
      if (mergedTypeInfo.selectionSets == null) {
        return;
      }

      acc[typeName] = Object.create(null);

      mergedTypeInfo.selectionSets.forEach((selectionSet, subschemaConfig) => {
        const schema = subschemaConfig.schema;
        const fields = (schema.getType(typeName) as GraphQLObjectType | GraphQLInterfaceType).getFields();
        Object.keys(fields).forEach(fieldName => {
          if (acc[typeName][fieldName] == null) {
            acc[typeName][fieldName] = {
              kind: Kind.SELECTION_SET,
              selections: [parseSelectionSet('{ __typename }').selections[0]],
            };
          }
          acc[typeName][fieldName].selections = acc[typeName][fieldName].selections.concat(selectionSet.selections);
        });
      });
      return acc;
    },
    Object.create(null)
  );

  return {
    transformedSchemas,
    fragmentsByField: undefined,
    selectionSetsByField,
    dynamicSelectionSetsByField: undefined,
    mergedTypes,
  };
}

function createMergedTypes(
  typeCandidates: Record<string, Array<MergeTypeCandidate>>,
  mergeTypes?: boolean | Array<string> | MergeTypeFilter
): Record<string, MergedTypeInfo> {
  const mergedTypes: Record<string, MergedTypeInfo> = Object.create(null);

  Object.keys(typeCandidates).forEach(typeName => {
    if (isObjectType(typeCandidates[typeName][0].type)) {
      const mergedTypeCandidates = typeCandidates[typeName].filter(
        typeCandidate =>
          typeCandidate.subschema != null &&
          isSubschemaConfig(typeCandidate.subschema) &&
          typeCandidate.subschema.merge != null &&
          typeName in typeCandidate.subschema.merge
      );

      if (
        mergeTypes === true ||
        (typeof mergeTypes === 'function' && mergeTypes(typeCandidates[typeName], typeName)) ||
        (Array.isArray(mergeTypes) && mergeTypes.includes(typeName)) ||
        mergedTypeCandidates.length
      ) {
        const subschemas: Array<SubschemaConfig> = [];

        const fields = Object.create({});
        const typeMaps: Map<SubschemaConfig, TypeMap> = new Map();
        const selectionSets: Map<SubschemaConfig, SelectionSetNode> = new Map();

        mergedTypeCandidates.forEach(typeCandidate => {
          const subschemaConfig = typeCandidate.subschema as SubschemaConfig;
          const transformedSubschema = typeCandidate.transformedSubschema;
          typeMaps.set(subschemaConfig, transformedSubschema.getTypeMap());
          const type = transformedSubschema.getType(typeName) as GraphQLObjectType;
          const fieldMap = type.getFields();
          Object.keys(fieldMap).forEach(fieldName => {
            if (!(fieldName in fields)) {
              fields[fieldName] = [];
            }
            fields[fieldName].push(subschemaConfig);
          });

          const mergedTypeConfig = subschemaConfig.merge[typeName];

          if (mergedTypeConfig.selectionSet) {
            const selectionSet = parseSelectionSet(mergedTypeConfig.selectionSet);
            selectionSets.set(subschemaConfig, selectionSet);
          }

          if (!mergedTypeConfig.resolve) {
            if (mergedTypeConfig.key != null) {
              const batchDelegateToSubschema = createBatchDelegateFn(
                mergedTypeConfig.args,
                ({ schema, selectionSet, context, info }) => ({
                  schema,
                  operation: 'query',
                  fieldName: mergedTypeConfig.fieldName,
                  selectionSet,
                  context,
                  info,
                  skipTypeMerging: true,
                })
              );

              mergedTypeConfig.resolve = (originalResult, context, info, subschema, selectionSet) =>
                batchDelegateToSubschema({
                  key: mergedTypeConfig.key(originalResult),
                  schema: subschema,
                  context,
                  info,
                  selectionSet,
                });
            } else {
              mergedTypeConfig.resolve = (originalResult, context, info, subschema, selectionSet) =>
                delegateToSchema({
                  schema: subschema,
                  operation: 'query',
                  fieldName: mergedTypeConfig.fieldName,
                  returnType: getNamedType(info.returnType) as GraphQLOutputType,
                  args: mergedTypeConfig.args(originalResult),
                  selectionSet,
                  context,
                  info,
                  skipTypeMerging: true,
                });
            }
          }

          subschemas.push(subschemaConfig);
        });

        const targetSubschemas: Map<SubschemaConfig, Array<SubschemaConfig>> = new Map();
        subschemas.forEach(subschema => {
          const filteredSubschemas = subschemas.filter(s => s !== subschema);
          if (filteredSubschemas.length) {
            targetSubschemas.set(subschema, filteredSubschemas);
          }
        });

        mergedTypes[typeName] = {
          targetSubschemas,
          typeMaps,
          selectionSets,
          containsSelectionSet: new Map(),
          uniqueFields: Object.create({}),
          nonUniqueFields: Object.create({}),
        };

        subschemas.forEach(subschema => {
          const type = typeMaps.get(subschema)[typeName] as GraphQLObjectType;
          const subschemaMap = new Map();
          subschemas
            .filter(s => s !== subschema)
            .forEach(s => {
              const selectionSet = selectionSets.get(s);
              if (selectionSet != null && typeContainsSelectionSet(type, selectionSet)) {
                subschemaMap.set(selectionSet, true);
              }
            });
          mergedTypes[typeName].containsSelectionSet.set(subschema, subschemaMap);
        });

        Object.keys(fields).forEach(fieldName => {
          const supportedBySubschemas = fields[fieldName];
          if (supportedBySubschemas.length === 1) {
            mergedTypes[typeName].uniqueFields[fieldName] = supportedBySubschemas[0];
          } else {
            mergedTypes[typeName].nonUniqueFields[fieldName] = supportedBySubschemas;
          }
        });
      }
    }
  });

  return mergedTypes;
}

export function completeStitchingInfo(stitchingInfo: StitchingInfo, resolvers: IResolvers): StitchingInfo {
  const selectionSetsByField = stitchingInfo.selectionSetsByField;
  const dynamicSelectionSetsByField = Object.create(null);
  const rawFragments: Array<{ field: string; fragment: string }> = [];

  Object.keys(resolvers).forEach(typeName => {
    const type = resolvers[typeName];
    if (isScalarType(type)) {
      return;
    }
    Object.keys(type).forEach(fieldName => {
      const field = type[fieldName] as IFieldResolverOptions;
      if (field.selectionSet) {
        if (typeof field.selectionSet === 'function') {
          if (!(typeName in dynamicSelectionSetsByField)) {
            dynamicSelectionSetsByField[typeName] = Object.create(null);
          }

          if (!(fieldName in dynamicSelectionSetsByField[typeName])) {
            dynamicSelectionSetsByField[typeName][fieldName] = [];
          }

          dynamicSelectionSetsByField[typeName][fieldName].push(field.selectionSet);
        } else {
          const selectionSet = parseSelectionSet(field.selectionSet);
          if (!(typeName in selectionSetsByField)) {
            selectionSetsByField[typeName] = Object.create(null);
          }

          if (!(fieldName in selectionSetsByField[typeName])) {
            selectionSetsByField[typeName][fieldName] = {
              kind: Kind.SELECTION_SET,
              selections: [],
            };
          }
          selectionSetsByField[typeName][fieldName].selections = selectionSetsByField[typeName][
            fieldName
          ].selections.concat(selectionSet.selections);
        }
      }
      if (field.fragment) {
        rawFragments.push({
          field: fieldName,
          fragment: field.fragment,
        });
      }
    });
  });

  const parsedFragments = Object.create(null);
  rawFragments.forEach(({ field, fragment }) => {
    const parsedFragment = parseFragmentToInlineFragment(fragment);
    const actualTypeName = parsedFragment.typeCondition.name.value;
    if (!(actualTypeName in parsedFragments)) {
      parsedFragments[actualTypeName] = Object.create(null);
    }

    if (!(field in parsedFragments[actualTypeName])) {
      parsedFragments[actualTypeName][field] = [];
    }
    parsedFragments[actualTypeName][field].push(parsedFragment);
  });

  const fragmentsByField = Object.create(null);
  Object.keys(parsedFragments).forEach(typeName => {
    Object.keys(parsedFragments[typeName]).forEach(field => {
      if (!(typeName in fragmentsByField)) {
        fragmentsByField[typeName] = Object.create(null);
      }

      fragmentsByField[typeName][field] = concatInlineFragments(typeName, parsedFragments[typeName][field]);
    });
  });

  stitchingInfo.selectionSetsByField = selectionSetsByField;
  stitchingInfo.dynamicSelectionSetsByField = dynamicSelectionSetsByField;
  stitchingInfo.fragmentsByField = fragmentsByField;

  return stitchingInfo;
}

export function addStitchingInfo(stitchedSchema: GraphQLSchema, stitchingInfo: StitchingInfo): GraphQLSchema {
  return new GraphQLSchema({
    ...stitchedSchema.toConfig(),
    extensions: {
      ...stitchedSchema.extensions,
      stitchingInfo,
    },
  });
}
