import SwiftUI
import UniformTypeIdentifiers

@main
struct PersonalOSCompanionApp: App {
    var body: some Scene {
        WindowGroup {
            if ProcessInfo.processInfo.environment["PERSONAL_OS_SYNTHETIC_XCTEST"] == "1" {
                // Hosted XCTest must not construct the normal model, read its
                // files, inspect system permissions or end system activities.
                Text("Synthetic XCTest host")
            } else {
                CompanionScreen()
            }
        }
    }
}

private struct CompanionScreen: View {
    @StateObject private var model = CompanionModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var importing = false

    var body: some View {
            NavigationStack {
                List {
                    Section("手机提醒") {
                        Text("本机提醒与倒计时；iOS 26 支持提前预约启动。")
                        Button("允许系统通知") { Task { await model.requestPermission() } }
                        Button("导入 Personal OS 配置") { importing = true }
                        Button("两分钟模拟验收") { model.demo() }
                        if #available(iOS 26.0, *) {
                            Button("30 秒后预约上岛模拟") { model.demo(scheduled: true) }
                        }
                    }
                    Section("设备权限与接入") {
                        Text(model.permissionState?.displayText ?? "正在读取本机权限…")
                        Button("重新读取权限") { Task { await model.foreground() } }
                        Text("当前使用本机配置，无后台任务同步。预约或启动后，请在锁屏与灵动岛确认实际显示。") .font(.caption)
                    }
                    if let snapshot = model.preview {
                        Section("待安排：请核对") {
                            ForEach(snapshot.plans) { plan in
                                VStack(alignment: .leading) {
                                    Text(plan.title).font(.headline)
                                    if let date = plan.eventDate { Text("开始 \(date.formatted())") }
                                    ForEach(plan.reminderAt, id: \.self) { at in
                                        Text("提醒 \(Date(timeIntervalSince1970: at).formatted())").font(.caption)
                                    }
                                    if !plan.enabled { Text("停用本机提醒与倒计时") }
                                }
                            }
                            Button("安排 / 更新这些本机提醒") { Task { await model.installPreview() } }.disabled(model.busy)
                        }
                    }
                    Section("本机配置") {
                        ForEach(model.projections, id: \.plan.taskId) { item in
                            VStack(alignment: .leading, spacing: 10) {
                                Text(item.plan.title).font(.headline)
                                if let end = item.plan.eventDate {
                                    Text("开始 \(end.formatted())").font(.caption)
                                    Text("倒计时窗口：提前一小时。可现在手动启动；iOS 26 可在窗口前预约。") .font(.caption)
                                }
                                Button("启动倒计时") { Task { await model.startActivity(item.plan) } }.disabled(!item.plan.enabled)
                                if #available(iOS 26.0, *) {
                                    Button("预约提前一小时倒计时") { Task { await model.startActivity(item.plan, scheduled: true) } }.disabled(!item.plan.enabled)
                                }
                                Button("关闭倒计时") { Task { await model.closeActivity(item.plan) } }
                                Button("移除本机提醒", role: .destructive) { Task { await model.remove(item.plan) } }
                            }
                        }
                    }
                    Section("状态") { Text(model.status).accessibilityIdentifier("companion-status") }
                    Section {
                        Text("任务改期、完成或清除提醒后，请重新导入对应任务。系统专注模式、通知设置及设备状态可能影响可见提醒；待发送回读不代表已送达。")
                        Text("网页 / Google Tasks 是任务真源。本机配置是提醒投影，不会写回任务。")
                    }
                }
                .navigationTitle("Personal OS")
                .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                    switch result {
                    case .success(let url): model.importFile(url)
                    case .failure(let error): model.status = error.localizedDescription
                    }
                }
                .onOpenURL { model.importFile($0) }
                .task { await model.foreground() }
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active { Task { await model.foreground() } }
                }
            }
    }
}
