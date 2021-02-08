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
        os_log("HELLO")
        let server = Process()
        os_log("HOW ARE YOU?")
        server.executableURL = Bundle.main.url(forResource: "TabFSServer", withExtension: "")!
        os_log("I AM GOOD")
        server.launch()
        os_log("GREAT")
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
