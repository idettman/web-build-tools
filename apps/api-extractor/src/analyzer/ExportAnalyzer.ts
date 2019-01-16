// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as ts from 'typescript';
import { InternalError } from '@microsoft/node-core-library';

import { TypeScriptHelpers } from './TypeScriptHelpers';
import { AstSymbol } from './AstSymbol';
import { IAstImportOptions } from './AstImport';
import { AstModule } from './AstModule';

export interface IAstSymbolTable {
  fetchAstSymbol(followedSymbol: ts.Symbol, addIfMissing: boolean,
    astImportOptions: IAstImportOptions | undefined): AstSymbol | undefined;

  analyze(astSymbol: AstSymbol): void;
}

export class ExportAnalyzer {
  private readonly _program: ts.Program;
  private readonly _typeChecker: ts.TypeChecker;
  private readonly _astSymbolTable: IAstSymbolTable;

  private readonly _astModulesBySourceFile: Map<ts.SourceFile, AstModule>
    = new Map<ts.SourceFile, AstModule>();

  public constructor(program: ts.Program, typeChecker: ts.TypeChecker, astSymbolTable: IAstSymbolTable) {
    this._program = program;
    this._typeChecker = typeChecker;
    this._astSymbolTable = astSymbolTable;
  }

  /**
   * For a given source file, this analyzes all of its exports and produces an AstModule
   * object.
   */
  public fetchAstModuleBySourceFile(sourceFile: ts.SourceFile, moduleSpecifier: string | undefined): AstModule {
    // Don't traverse into a module that we already processed before:
    // The compiler allows m1 to have "export * from 'm2'" and "export * from 'm3'",
    // even if m2 and m3 both have "export * from 'm4'".
    let astModule: AstModule | undefined = this._astModulesBySourceFile.get(sourceFile);

    if (!astModule) {
      astModule = new AstModule(sourceFile);
      this._astModulesBySourceFile.set(sourceFile, astModule);

      const moduleSymbol: ts.Symbol = TypeScriptHelpers.getSymbolForDeclaration(sourceFile);

      // Match:       "@microsoft/sp-lodash-subset" or "lodash/has"
      // but ignore:  "../folder/LocalFile"
      if (moduleSpecifier !== undefined && !ts.isExternalModuleNameRelative(moduleSpecifier)) {
        // Yes, this is the entry point for an external package.
        astModule.externalModulePath = moduleSpecifier;

        for (const exportedSymbol of this._typeChecker.getExportsOfModule(moduleSymbol)) {

          const astImportOptions: IAstImportOptions = {
            exportName: exportedSymbol.name,
            modulePath: astModule.externalModulePath
          };

          const followedSymbol: ts.Symbol = TypeScriptHelpers.followAliases(exportedSymbol, this._typeChecker);
          const astSymbol: AstSymbol | undefined = this._astSymbolTable.fetchAstSymbol(
            followedSymbol, true, astImportOptions);

          if (!astSymbol) {
            throw new Error('Unsupported export: ' + exportedSymbol.name);
          }

          astModule.exportedSymbols.set(exportedSymbol.name, astSymbol);
        }
      } else {

        if (moduleSymbol.exports) {
          for (const exportedSymbol of moduleSymbol.exports.values() as IterableIterator<ts.Symbol>) {

            if (exportedSymbol.escapedName === ts.InternalSymbolName.ExportStar) {
              // Special handling for "export * from 'module-name';" declarations, which are all attached to a single
              // symbol whose name is InternalSymbolName.ExportStar
              for (const exportStarDeclaration of exportedSymbol.getDeclarations() || []) {
                this._collectExportsFromExportStar(astModule, exportStarDeclaration);
              }

            } else {
              const fetchedAstSymbol: AstSymbol | undefined = this._fetchAstSymbolFromModule(astModule, exportedSymbol);
              if (fetchedAstSymbol !== undefined) {
                this._astSymbolTable.analyze(fetchedAstSymbol);
                astModule.exportedSymbols.set(exportedSymbol.name, fetchedAstSymbol);
              }
            }
          }

        }

      }
    }

    return astModule;
  }

  public fetchReferencedAstSymbol(symbol: ts.Symbol, sourceFile: ts.SourceFile): AstSymbol | undefined {
    const astModule: AstModule | undefined = this._astModulesBySourceFile.get(sourceFile);
    if (astModule === undefined) {
      throw new InternalError('fetchReferencedAstSymbol() called for a source file that was not analyzed');
    }

    return this._fetchAstSymbolFromModule(astModule, symbol);
  }

  private _fetchAstSymbolFromModule(astModule: AstModule, symbol: ts.Symbol): AstSymbol | undefined {
    let current: ts.Symbol = symbol;

    while (true) { // tslint:disable-line:no-constant-condition

      // Is this symbol an import/export that we need to follow to find the real declaration?
      for (const declaration of current.declarations || []) {
        if (this._matchExportDeclaration(astModule, symbol, declaration)) {
          return;
        }
        if (this._matchImportDeclaration(astModule, symbol, declaration)) {
          return;
        }
      }

      if (!(current.flags & ts.SymbolFlags.Alias)) { // tslint:disable-line:no-bitwise
        break;
      }

      const currentAlias: ts.Symbol = TypeScriptHelpers.getImmediateAliasedSymbol(current, this._typeChecker);
      // Stop if we reach the end of the chain
      if (!currentAlias || currentAlias === current) {
        break;
      }

      current = currentAlias;
    }

    // Otherwise, assume it is a normal declaration
    return this._astSymbolTable.fetchAstSymbol(current, true, undefined);
  }

  private _matchExportDeclaration(astModule: AstModule, exportedSymbol: ts.Symbol,
    declaration: ts.Declaration): boolean {

    const exportDeclaration: ts.ExportDeclaration | undefined
      = TypeScriptHelpers.findFirstParent<ts.ExportDeclaration>(declaration, ts.SyntaxKind.ExportDeclaration);

    if (exportDeclaration) {
      let exportName: string | undefined = undefined;

      if (declaration.kind === ts.SyntaxKind.ExportSpecifier) {
        // EXAMPLE:
        // "export { A } from './file-a';"
        //
        // ExportDeclaration:
        //   ExportKeyword:  pre=[export] sep=[ ]
        //   NamedExports:
        //     FirstPunctuation:  pre=[{] sep=[ ]
        //     SyntaxList:
        //       ExportSpecifier:  <------------- declaration
        //         Identifier:  pre=[A] sep=[ ]
        //     CloseBraceToken:  pre=[}] sep=[ ]
        //   FromKeyword:  pre=[from] sep=[ ]
        //   StringLiteral:  pre=['./file-a']
        //   SemicolonToken:  pre=[;]

        // Example: " ExportName as RenamedName"
        const exportSpecifier: ts.ExportSpecifier = declaration as ts.ExportSpecifier;
        exportName = (exportSpecifier.propertyName || exportSpecifier.name).getText().trim();
      } else {
        throw new InternalError('Unimplemented export declaration kind: ' + declaration.getText());
      }

      // Ignore "export { A }" without a module specifier
      if (exportDeclaration.moduleSpecifier) {
        const specifierAstModule: AstModule = this._fetchSpecifierAstModule(exportDeclaration);
        const exportedAstSymbol: AstSymbol = this._getExportOfAstModule(exportName, specifierAstModule);

        astModule.exportedSymbols.set(exportedSymbol.name, exportedAstSymbol);

        return true;
      }
    }

    return false;
  }

  private _matchImportDeclaration(astModule: AstModule, exportedSymbol: ts.Symbol,
    declaration: ts.Declaration): boolean {

    const importDeclaration: ts.ImportDeclaration | undefined
      = TypeScriptHelpers.findFirstParent<ts.ImportDeclaration>(declaration, ts.SyntaxKind.ImportDeclaration);

    if (importDeclaration) {
      let exportName: string;

      if (declaration.kind === ts.SyntaxKind.NamespaceImport) {
        // EXAMPLE:
        // "import * as theLib from 'the-lib';"
        //
        // ImportDeclaration:
        //   ImportKeyword:  pre=[import] sep=[ ]
        //   ImportClause:
        //     NamespaceImport:  <------------- declaration
        //       AsteriskToken:  pre=[*] sep=[ ]
        //       AsKeyword:  pre=[as] sep=[ ]
        //       Identifier:  pre=[theLib] sep=[ ]
        //   FromKeyword:  pre=[from] sep=[ ]
        //   StringLiteral:  pre=['the-lib']
        //   SemicolonToken:  pre=[;]

        throw new InternalError('"import * as x" is not supported yet');
      }

      if (declaration.kind === ts.SyntaxKind.ImportSpecifier) {
        // EXAMPLE:
        // "import { A, B } from 'the-lib';"
        //
        // ImportDeclaration:
        //   ImportKeyword:  pre=[import] sep=[ ]
        //   ImportClause:
        //     NamedImports:
        //       FirstPunctuation:  pre=[{] sep=[ ]
        //       SyntaxList:
        //         ImportSpecifier:  <------------- declaration
        //           Identifier:  pre=[A]
        //         CommaToken:  pre=[,] sep=[ ]
        //         ImportSpecifier:
        //           Identifier:  pre=[B] sep=[ ]
        //       CloseBraceToken:  pre=[}] sep=[ ]
        //   FromKeyword:  pre=[from] sep=[ ]
        //   StringLiteral:  pre=['the-lib']
        //   SemicolonToken:  pre=[;]

        // Example: " ExportName as RenamedName"
        const importSpecifier: ts.ImportSpecifier = declaration as ts.ImportSpecifier;
        exportName = (importSpecifier.propertyName || importSpecifier.name).getText().trim();
      } else if (declaration.kind === ts.SyntaxKind.ImportClause) {
        // EXAMPLE:
        // "import A, { B } from './A';"
        //
        // ImportDeclaration:
        //   ImportKeyword:  pre=[import] sep=[ ]
        //   ImportClause:  <------------- declaration (referring to A)
        //     Identifier:  pre=[A]
        //     CommaToken:  pre=[,] sep=[ ]
        //     NamedImports:
        //       FirstPunctuation:  pre=[{] sep=[ ]
        //       SyntaxList:
        //         ImportSpecifier:
        //           Identifier:  pre=[B] sep=[ ]
        //       CloseBraceToken:  pre=[}] sep=[ ]
        //   FromKeyword:  pre=[from] sep=[ ]
        //   StringLiteral:  pre=['./A']
        //   SemicolonToken:  pre=[;]
        exportName = ts.InternalSymbolName.Default;
      } else {
        throw new InternalError('Unimplemented import declaration kind: ' + declaration.getText());
      }

      const specifierAstModule: AstModule = this._fetchSpecifierAstModule(importDeclaration);
      const exportedAstSymbol: AstSymbol = this._getExportOfAstModule(exportName, specifierAstModule);

      astModule.exportedSymbols.set(exportedSymbol.name, exportedAstSymbol);
      return true;
    }

    return false;
  }

  private _getExportOfAstModule(exportName: string, astModule: AstModule): AstSymbol {
    const visitedAstModules: Set<AstModule> = new Set<AstModule>();
    const astSymbol: AstSymbol | undefined = this._tryGetExportOfAstModule(exportName, astModule, visitedAstModules);
    if (astSymbol === undefined) {
      throw new InternalError(`Unable to analyze the export ${JSON.stringify(exportName)}`);
    }
    return astSymbol;
  }

  private _tryGetExportOfAstModule(exportName: string, astModule: AstModule,
    visitedAstModules: Set<AstModule>): AstSymbol | undefined {

    if (visitedAstModules.has(astModule)) {
      return undefined;
    }
    visitedAstModules.add(astModule);

    let astSymbol: AstSymbol | undefined = astModule.exportedSymbols.get(exportName);
    if (astSymbol !== undefined) {
      return astSymbol;
    }

    // Try each of the star imports
    for (const starExportedModule of astModule.starExportedExternalModules) {
      astSymbol = this._tryGetExportOfAstModule(exportName, starExportedModule, visitedAstModules);
      if (astSymbol !== undefined) {
        return astSymbol;
      }
    }

    return undefined;
  }

  private _collectExportsFromExportStar(astModule: AstModule, exportStarDeclaration: ts.Declaration): void {
    if (ts.isExportDeclaration(exportStarDeclaration)) {

      const starExportedModule: AstModule | undefined = this._fetchSpecifierAstModule(exportStarDeclaration);
      if (starExportedModule !== undefined) {
        if (starExportedModule.isExternal) {
          astModule.starExportedExternalModules.add(starExportedModule);
        } else {
          for (const [exportName, exportedSymbol] of starExportedModule.exportedSymbols) {
            if (!astModule.exportedSymbols.has(exportName)) {
              astModule.exportedSymbols.set(exportName, exportedSymbol);
            }
          }
          for (const starExportedExternalModule of starExportedModule.starExportedExternalModules) {
            astModule.starExportedExternalModules.add(starExportedExternalModule);
          }
        }
      }

    } else {
      // Ignore ExportDeclaration nodes that don't match the expected pattern
      // TODO: Should we report a warning?
    }
  }

  private _fetchSpecifierAstModule(exportStarDeclaration: ts.ImportDeclaration | ts.ExportDeclaration): AstModule {

    // The name of the module, which could be like "./SomeLocalFile' or like 'external-package/entry/point'
    const moduleSpecifier: string | undefined = TypeScriptHelpers.getModuleSpecifier(exportStarDeclaration);
    if (!moduleSpecifier) {
      throw new InternalError('Unable to parse module specifier');
    }

    const resolvedModule: ts.ResolvedModuleFull | undefined = TypeScriptHelpers.getResolvedModule(
      exportStarDeclaration.getSourceFile(), moduleSpecifier);

    if (resolvedModule === undefined) {
      // This should not happen, since getResolvedModule() specifically looks up names that the compiler
      // found in export declarations for this source file
      throw new InternalError('getResolvedModule() could not resolve module name ' + JSON.stringify(moduleSpecifier));
    }

    // Map the filename back to the corresponding SourceFile. This circuitous approach is needed because
    // we have no way to access the compiler's internal resolveExternalModuleName() function
    const moduleSourceFile: ts.SourceFile | undefined = this._program.getSourceFile(resolvedModule.resolvedFileName);
    if (!moduleSourceFile) {
      // This should not happen, since getResolvedModule() specifically looks up names that the compiler
      // found in export declarations for this source file
      throw new InternalError('getSourceFile() failed to locate ' + JSON.stringify(resolvedModule.resolvedFileName));
    }

    const specifierAstModule: AstModule = this.fetchAstModuleBySourceFile(moduleSourceFile, moduleSpecifier);
    return specifierAstModule;
  }
}
