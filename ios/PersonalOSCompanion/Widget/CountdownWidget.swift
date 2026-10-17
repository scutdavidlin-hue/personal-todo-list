import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

struct CountdownText: View {
    let state: CountdownAttributes.ContentState
    var body: some View {
        Text(timerInterval: state.startDate...state.eventDate, countsDown: true, showsHours: false)
            .monospacedDigit()
            .accessibilityLabel("距离开始的倒计时")
    }
}

struct CountdownWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: CountdownAttributes.self) { context in
            VStack(alignment: .leading, spacing: 8) {
                Text(context.attributes.title).font(.headline).lineLimit(2)
                HStack {
                    CountdownText(state: context.state).font(.title2).bold()
                    Spacer()
                    Button(intent: CloseCountdownIntent(taskId: context.attributes.taskId)) {
                        Label("关闭", systemImage: "xmark.circle")
                    }.buttonStyle(.bordered)
                }
            }.padding().activityBackgroundTint(Color(red: 0.09, green: 0.21, blue: 0.15)).activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: "timer") }
                DynamicIslandExpandedRegion(.trailing) { CountdownText(state: context.state).frame(width: 74) }
                DynamicIslandExpandedRegion(.bottom) {
                    HStack {
                        Text(context.attributes.title).lineLimit(2)
                        Spacer()
                        Button(intent: CloseCountdownIntent(taskId: context.attributes.taskId)) { Label("关闭", systemImage: "xmark.circle") }
                    }
                }
            } compactLeading: {
                Image(systemName: "timer").foregroundStyle(.green)
            } compactTrailing: {
                CountdownText(state: context.state).frame(width: 58)
            } minimal: {
                Image(systemName: "timer").foregroundStyle(.green)
            }
        }
    }
}

@main
struct CompanionWidgets: WidgetBundle {
    var body: some Widget { CountdownWidget() }
}
