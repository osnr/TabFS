//
//  TabFSService.swift
//  TabFSService
//
//  Created by Omar Rizwan on 2/7/21.
//

import Foundation

class TabFSService: NSObject, TabFSServiceProtocol {
    var fs: Process!
    var fsInput: FileHandle!
    var fsOutput: FileHandle!
    
    init(app: TabFSServiceConsumerProtocol) {
        super.init()
        
        fs = Process()
        fs.executableURL = URL(fileURLWithPath: "/Users/osnr/Code/tabfs/fs/tabfs")
        fs.currentDirectoryURL = fs.executableURL?.deletingLastPathComponent()
        
        fs.arguments = []
        
        let inputPipe = Pipe(), outputPipe = Pipe()
        fs.standardInput = inputPipe
        fs.standardOutput = outputPipe
        
        fsInput = inputPipe.fileHandleForWriting
        fsOutput = outputPipe.fileHandleForReading
        
        try! fs.run()
        
        // split new thread
        DispatchQueue.global(qos: .default).async {
            while true {
                // read from them
                let length = self.fsOutput.readData(ofLength: 4).withUnsafeBytes { $0.load(as: UInt32.self) }
                let req = self.fsOutput.readData(ofLength: Int(length))
                // send to other side of XPC conn
                app.request(req)
            }
        }
        
        // FIXME: disable auto termination
    }
    
    func upperCaseString(_ string: String, withReply reply: @escaping (String) -> Void) {
        let response = string.uppercased()
        reply(response)
    }
    
    func response(_ resp: Data) {
        fsInput.write(withUnsafeBytes(of: UInt32(resp.count)) { Data($0) })
        fsInput.write(resp)
    }
}

class TabFSServiceDelegate: NSObject, NSXPCListenerDelegate {
    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection newConnection: NSXPCConnection) -> Bool {
        newConnection.remoteObjectInterface = NSXPCInterface(with: TabFSServiceConsumerProtocol.self)
        
        let exportedObject = TabFSService(app: newConnection.remoteObjectProxy as! TabFSServiceConsumerProtocol)
        newConnection.exportedInterface = NSXPCInterface(with: TabFSServiceProtocol.self)
        newConnection.exportedObject = exportedObject
        
        newConnection.resume()
        return true
    }
}
