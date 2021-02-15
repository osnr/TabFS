//
//  TabFSService.swift
//  TabFSService
//
//  Created by Omar Rizwan on 2/7/21.
//

import Foundation
import Network
import os.log

class TabFSService: NSObject, TabFSServiceProtocol {
    func start(withReply reply: @escaping () -> Void) {
        // This XPC call is enough to just force the XPC service to be started.
        
        // kill old copies of TabFSServer
        let killall = Process()
        killall.launchPath = "/usr/bin/killall"
        killall.arguments = ["TabFSServer"]
        killall.launch()
        killall.waitUntilExit()
        
        // spin until old TabFSServer (if any) is gone
        while true {
            let pgrep = Process()
            pgrep.launchPath = "/usr/bin/pgrep"
            pgrep.arguments = ["TabFSServer"]
            pgrep.launch()
            pgrep.waitUntilExit()
            if pgrep.terminationStatus != 0 { break }
            
            Thread.sleep(forTimeInterval: 0.01)
        }
        
        let server = Process()
        let serverOutput = Pipe()
        server.executableURL = Bundle.main.url(forResource: "TabFSServer", withExtension: "")!
        server.standardOutput = serverOutput
        server.launch()
        
        // FIXME: should we wait for some signal that the server is ready?
        // right now, background.js will just periodically retry until it can connect.
        
        // tell background.js to try to connect.
        reply()
    }
}

class TabFSServiceDelegate: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection newConnection: NSXPCConnection) -> Bool {
        let exportedObject = TabFSService()
        newConnection.exportedInterface = NSXPCInterface(with: TabFSServiceProtocol.self)
        newConnection.exportedObject = exportedObject
        
        newConnection.resume()
        return true
    }
}
