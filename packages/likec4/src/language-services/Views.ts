import type { ComputedView, DiagramView, ViewID } from '@likec4/core'
import type { DotLayoutResult, DotSource, GraphvizLayouter } from '@likec4/layouts'
import type { WorkspaceCache } from 'langium'
import { SimpleCache } from 'langium'
import pLimit from 'p-limit'
import { isTruthy } from 'remeda'
import type { CliServices } from './module'

const limit = pLimit(4)

type GraphvizOut = {
  id: ViewID
  dot: DotSource
  svg: string
}

export class Views {
  private cache = new WeakMap<ComputedView, DotLayoutResult>()

  private svgCache = new SimpleCache<DotSource, string>()

  private layouter: GraphvizLayouter

  private previousAction = Promise.resolve() as Promise<unknown>

  constructor(private services: CliServices) {
    this.layouter = services.likec4.Layouter
  }

  computedViews(): ComputedView[] {
    const modelBuilder = this.services.likec4.ModelBuilder
    const views = modelBuilder.buildModel()?.views ?? {}
    return Object.values(views)
  }

  async layoutViews(): Promise<ReadonlyArray<Readonly<DotLayoutResult>>> {
    const logger = this.services.logger
    const KEY = 'All-LayoutedViews'
    const cache = this.services.WorkspaceCache as WorkspaceCache<string, DotLayoutResult[]>
    if (cache.has(KEY)) {
      // logger.info(`[Views] Using cached layouted views`)
      return await Promise.resolve(cache.get(KEY)!)
    }

    const action = this.previousAction
      .then(async () => {
        // Possible we have cached results in previousAction
        if (cache.has(KEY)) {
          // logger.info(`[Views] Using cached layouted views`)
          return Promise.resolve(cache.get(KEY)!)
        }

        const modelBuilder = this.services.likec4.ModelBuilder
        const views = modelBuilder.buildModel()?.views
        if (!views) {
          return []
        }

        const tasks = Object.values(views).map(view =>
          limit(async () => {
            try {
              let result = this.cache.get(view)
              if (!result) {
                // console.debug(`cache miss layout: ${view.id}`)
                result = await this.layouter.layout(view)
                this.cache.set(view, result)
              } else {
                // console.debug(`cache hit layout: ${view.id}`)
              }
              return result
            } catch (e) {
              logger.error(e)
              return null
            }
          })
        )

        const results = (await Promise.all(tasks)).filter(isTruthy)
        cache.set(KEY, results)
        return results
      })
      .catch(e => {
        // Ignore errors from previousPromise
        logger.error(e)
        cache.delete(KEY)
        return Promise.resolve([])
      })
    this.previousAction = action
    return await action
  }

  async diagrams(): Promise<ReadonlyArray<DiagramView>> {
    const layouted = await this.layoutViews()
    return layouted.map(l => l.diagram)
  }

  async viewsAsGraphvizOut(): Promise<ReadonlyArray<GraphvizOut>> {
    const KEY = 'All-LayoutedViews-DotWithSvg'
    const cache = this.services.WorkspaceCache as WorkspaceCache<string, GraphvizOut[]>
    if (cache.has(KEY)) {
      return await Promise.resolve(cache.get(KEY)!)
    }

    const layouted = await this.layoutViews()
    const svgCache = this.svgCache
    const tasks = layouted.map(l =>
      limit(async (): Promise<GraphvizOut> => {
        let svg = svgCache.get(l.dot)
        if (!svg) {
          svg = await this.layouter.svg(l.dot, l.diagram)
          svgCache.set(l.dot, svg)
        }
        return {
          id: l.diagram.id,
          dot: l.dot,
          svg
        }
      })
    )
    const results = await Promise.all(tasks)
    cache.set(KEY, results)
    return results
  }
}
