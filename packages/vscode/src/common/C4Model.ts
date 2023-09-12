import { invariant } from '@likec4/core'
import type { ComputedView, DiagramView as LayoutedView, LikeC4Model, ViewID } from '@likec4/core'
import type { DotLayouter } from '@likec4/layouts'
import { equals, debounce as debounceFn } from 'rambdax'
import type * as vscode from 'vscode'
import type { MemoryStream } from 'xstream'
import xs from 'xstream'
import debounce from 'xstream/extra/debounce'
import dropRepeats from 'xstream/extra/dropRepeats'
import { Logger, logError } from '../logger'
import { disposable, disposeAll } from '../util'
import type { Rpc } from './Rpc'
import type TelemetryReporter from '@vscode/extension-telemetry'

function isNotNullish<T>(x: T): x is NonNullable<T> {
  return x !== undefined && x !== null
}

const StateKeyLikeC4Model = 'c4model:last'

export class C4Model implements vscode.Disposable {
  #activeSubscription: vscode.Disposable | null = null

  #lastKnownModel: LikeC4Model | null = null

  private _disposables: vscode.Disposable[] = []

  private modelStream: MemoryStream<LikeC4Model>

  constructor(
    private context: vscode.ExtensionContext,
    private telemetry: TelemetryReporter,
    private rpc: Rpc,
    private dot: DotLayouter
  ) {
    const fetchModelStream = xs
      .create<number>({
        start: listener => {
          invariant(this.#activeSubscription == null, 'modelStream already started')
          Logger.info('[Extension.C4Model.modelStream] subscribe onDidChangeModel')
          const unsubscribe = this.rpc.onDidChangeModel(() => {
            listener.next(1)
          })
          this.#activeSubscription = disposable(() => {
            this.#activeSubscription = null
            Logger.info('[Extension.C4Model.modelStream] unsubscribe onDidChangeModel')
            unsubscribe.dispose()
            listener.complete()
          })
          listener.next(0)
        },
        stop: () => {
          Logger.info('[Extension.C4Model.modelStream] stop')
          this.#activeSubscription?.dispose()
          this.#activeSubscription = null
        }
      })
      .compose(debounce(200))
      .map(() => this.fetchModel())
      .flatten()

    this.#lastKnownModel = context.workspaceState.get<LikeC4Model>(StateKeyLikeC4Model) ?? null
    if (this.#lastKnownModel) {
      Logger.info('[Extension.C4Model.modelStream] startWith persisted from workspaceState')
      this.modelStream = xs.merge(xs.of(this.#lastKnownModel), fetchModelStream).remember()
    } else {
      this.modelStream = fetchModelStream.remember()
    }
    Logger.info(`[Extension.C4Model] created`)
  }

  dispose() {
    Logger.info(`[Extension.C4Model] dispose`)
    disposeAll(this._disposables)
    this.#activeSubscription?.dispose()
  }

  private persistToWorkspaceState = debounceFn((model: LikeC4Model) => {
    if (equals(this.#lastKnownModel, model)) {
      Logger.debug('[Extension.C4Model.fetchModel] skip persisting to workspaceState')
      return
    }
    this.#lastKnownModel = model
    this.context.workspaceState.update(StateKeyLikeC4Model, model).then(
      () => Logger.debug('[Extension.C4Model.fetchModel] persist to workspaceState'),
      err => logError(err)
    )
  }, 5000)

  private fetchModel() {
    Logger.debug(`[Extension.C4Model] fetchModel`)
    return xs
      .fromPromise(this.rpc.fetchModel())
      .filter(isNotNullish)
      .replaceError(err => {
        logError(err)
        return xs.empty()
      })
      .map(model => {
        this.telemetry.sendTelemetryEvent(
          'fetchModel',
          {},
          {
            elements: Object.keys(model.elements).length,
            relationships: Object.keys(model.relations).length,
            views: Object.keys(model.views).length
          }
        )
        this.persistToWorkspaceState(model)
        return model
      })
  }

  private layoutView(view: ComputedView) {
    // this.logger.logDebug(`layoutView: ${view.id}`)
    return xs.fromPromise(this.dot.layout(view)).replaceError(err => {
      logError(err)
      return xs.empty()
    })
  }

  public subscribeToView(viewId: ViewID, callback: (diagram: LayoutedView) => void) {
    Logger.info(`[Extension.C4Model.subscribe] >> ${viewId}`)
    const subscription = this.modelStream
      .map(({ views }) => (viewId in views ? views[viewId] : null))
      .filter(isNotNullish)
      .compose(dropRepeats<ComputedView>(equals))
      .map(view => this.layoutView(view))
      .flatten()
      .subscribe({
        next: diagram => {
          callback(diagram)
        },
        error: err => {
          logError(err)
        }
      })

    return disposable(() => {
      Logger.info(`[Extension.C4Model.unsubscribe] -- ${viewId}`)
      subscription.unsubscribe()
    })
  }
}
