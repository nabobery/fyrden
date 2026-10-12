// A small command-line client over JGit, the second git implementation the
// interoperability suite runs against Fyrden. Run as a single source file:
//
//   java -cp "$FYRDEN_JGIT_CLASSPATH" FyrdenJGit.java <command> [args...]
//
// Commands: ls-remote <url>, clone <url> <dir> [depth], fetch <dir>,
// push <dir> <url> <refspec>...
// The token comes from FYRDEN_INTEROP_TOKEN (user x-access-token). Fetches
// use protocol v2 (JGit's default since 5.11); pushes use v0, as JGit always
// does. Exit status: 0 on success, 1 when a ref update was refused, 2 on errors.
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.eclipse.jgit.api.CloneCommand;
import org.eclipse.jgit.api.Git;
import org.eclipse.jgit.lib.Ref;
import org.eclipse.jgit.transport.CredentialsProvider;
import org.eclipse.jgit.transport.PushResult;
import org.eclipse.jgit.transport.RefSpec;
import org.eclipse.jgit.transport.RemoteRefUpdate;
import org.eclipse.jgit.transport.UsernamePasswordCredentialsProvider;

public class FyrdenJGit {
  public static void main(String[] args) throws Exception {
    String token = System.getenv("FYRDEN_INTEROP_TOKEN");
    CredentialsProvider credentials =
        new UsernamePasswordCredentialsProvider("x-access-token", token == null ? "" : token);
    try {
      System.exit(run(args, credentials));
    } catch (Exception e) {
      System.err.println("error: " + e);
      for (Throwable cause = e.getCause(); cause != null; cause = cause.getCause()) {
        System.err.println("caused by: " + cause);
      }
      System.exit(2);
    }
  }

  private static int run(String[] args, CredentialsProvider credentials) throws Exception {
    switch (args.length == 0 ? "" : args[0]) {
      case "ls-remote": {
        Map<String, Ref> refs =
            Git.lsRemoteRepository()
                .setRemote(args[1])
                .setCredentialsProvider(credentials)
                .callAsMap();
        for (Ref ref : refs.values()) {
          if (ref.isSymbolic()) continue;
          System.out.println(ref.getObjectId().name() + "\t" + ref.getName());
          if (ref.getPeeledObjectId() != null) {
            System.out.println(ref.getPeeledObjectId().name() + "\t" + ref.getName() + "^{}");
          }
        }
        return 0;
      }
      case "clone": {
        CloneCommand clone =
            Git.cloneRepository()
                .setURI(args[1])
                .setDirectory(new File(args[2]))
                .setCloneAllBranches(true)
                .setCredentialsProvider(credentials);
        if (args.length > 3) clone.setDepth(Integer.parseInt(args[3]));
        try (Git git = clone.call()) {
          return 0;
        }
      }
      case "fetch": {
        try (Git git = Git.open(new File(args[1]))) {
          git.fetch().setRemote("origin").setCredentialsProvider(credentials).call();
          return 0;
        }
      }
      case "push": {
        List<RefSpec> specs = new ArrayList<>();
        for (int i = 3; i < args.length; i++) specs.add(new RefSpec(args[i]));
        int status = 0;
        try (Git git = Git.open(new File(args[1]))) {
          for (PushResult result :
              git.push()
                  .setRemote(args[2])
                  .setRefSpecs(specs)
                  .setCredentialsProvider(credentials)
                  .call()) {
            for (RemoteRefUpdate update : result.getRemoteUpdates()) {
              System.out.println(update.getRemoteName() + " " + update.getStatus());
              RemoteRefUpdate.Status s = update.getStatus();
              if (s != RemoteRefUpdate.Status.OK && s != RemoteRefUpdate.Status.UP_TO_DATE) {
                status = 1;
              }
            }
          }
        }
        return status;
      }
      default:
        System.err.println("usage: FyrdenJGit ls-remote|clone|fetch|push ...");
        return 2;
    }
  }
}
