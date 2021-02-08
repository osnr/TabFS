//
//  TabFSServiceProtocols.swift
//  app-sandbox-xpc-test
//
//  Created by Omar Rizwan on 2/7/21.
//

import Foundation

@objc public protocol TabFSServiceProtocol {
    func upperCaseString(_ string: String, withReply reply: @escaping (String) -> Void)
}
